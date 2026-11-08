import { Sandbox } from "@vercel/sandbox";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ModelMessage } from "ai";
import { FatalError } from "workflow";
import type { PhaseSession } from "../court/phase-session.ts";
import { instructionSandboxLaunch } from "../evidence/broker.ts";
import { caseSandboxNames, saveSandboxBinding } from "../store.ts";
import { assertSandboxCleanupSafe, SandboxCleanupBlockedError } from "../lib/sandbox-cleanup.ts";
import { SourceToolSchemas, sourceToolsFor } from "./tools.ts";
import { ComputeSchema } from "../../sandbox/harness/compute.ts";
import { instructionBridgeConfig } from "./config.ts";
import { nativeResearchTools, type ProviderToolDefinition } from "./native-research.ts";
import type { ContinuationWriter } from "../domain/continuation.ts";

export function preparationDefinitions(phase: PhaseSession["state"]["phase"]) {
  return [
    ...sourceToolsFor(phase).map((name) => ({ type: "function" as const, name, description: name, inputSchema: z.toJSONSchema(SourceToolSchemas[name], { target: "draft-7" }) })),
    { type: "function" as const, name: "compute", description: "compute", inputSchema: z.toJSONSchema(ComputeSchema, { target: "draft-7" }) },
  ];
}

// Pipeline 3 instruction and criticism research with the provider's own tools,
// in one call; intake and debate prepare as in pipeline 2.
export function nativePreparationDefinitions(phase: PhaseSession["state"]["phase"], modelId: string) {
  return phase === "instruction" || phase === "criticism" ? nativeResearchTools(modelId, phase) : preparationDefinitions(phase);
}

// A native research call ends this long before its turn, so its result is read
// and the decision still starts within the turn.
export const NATIVE_CALL_MARGIN_MS = 15_000;

// The tools the session was opened with; pipeline 3 sessions hold provider tools.
function nativeDefinitions(session: PhaseSession): ProviderToolDefinition[] | undefined {
  const definitions = JSON.parse(session.state.tools) as Array<{ type: string }>;
  return definitions.length && definitions.every((definition) => definition.type === "provider") ? definitions as ProviderToolDefinition[] : undefined;
}

// A persistent VM snapshots its filesystem on every stop so the next turn of
// the phase can resume it. Older snapshots may still be referenced by a failed
// unit or a future continuation: neither expiration nor eviction releases them.
// This policy applies to future snapshots, not already-expiring historical ones.
export const PREPARATION_SNAPSHOTS = { snapshotExpiration: 0, keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: false } };

// A preparation call runs detached in the VM. One workflow step waits for it at
// most this long, then a later step waits again: no step holds a function for
// the length of a model call plus its tools, whatever the hosting plan allows.
export const PREPARATION_WAIT_MS = 60_000;

// The last call of a turn writes the analysis from what was gathered, without
// tools. Every call that requests tools ends, its tools included, this long
// before the turn does, so the synthesis always has time to run.
export const PREPARATION_SYNTHESIS_MS = 120_000;
// A call that requests tools needs at least this long of its own; with less,
// the turn goes straight to synthesis.
const PREPARATION_TOOL_STEP_MS = 60_000;

type PreparationDependencies = { sandbox: typeof Sandbox; bind: typeof saveSandboxBinding; writer?: ContinuationWriter };
type OpenedSandbox = { sandbox?: Sandbox };

async function openSandbox(session: PhaseSession, deps: PreparationDependencies, opened: OpenedSandbox): Promise<Sandbox> {
  if (opened.sandbox) return opened.sandbox;
  const { origin, snapshotId } = await instructionBridgeConfig();
  const launch = instructionSandboxLaunch(session.caseId, origin);
  const resuming = Boolean(session.state.sandboxId);
  const sandbox = session.state.sandboxId
    ? await deps.sandbox.get({ name: session.state.sandboxId, resume: false, signal: AbortSignal.timeout(10_000) })
    : await deps.sandbox.create({ source: { type: "snapshot", snapshotId }, timeout: 300_000, persistent: true, ...PREPARATION_SNAPSHOTS, networkPolicy: launch.networkPolicy, env: launch.env, tags: { case: session.caseId.slice(0, 32), phase: session.state.phase, seat: session.state.seat } });
  // update() is control-plane only in the installed SDK. Do this before any
  // method that can auto-resume the VM; a failed retention update starts no call.
  if (resuming) await sandbox.update(PREPARATION_SNAPSHOTS, { signal: AbortSignal.timeout(10_000) });
  opened.sandbox = sandbox;
  if (!session.state.sandboxId) { session.state.sandboxId = sandbox.name; await session.save(); }
  // Reuse the installed runtime/dependencies in the existing evidence snapshot,
  // but ship this deployment's harness. A code push needs no snapshot rebuild.
  if (!resuming) {
    const files = await Promise.all(["instruction-agent.ts", "compute.ts"].map(async (name) => ({
      path: `/opt/evidence-harness/${name}`, content: await readFile(path.join(process.cwd(), "sandbox/harness", name), "utf8"),
    })));
    await sandbox.writeFiles(files);
  }
  return sandbox;
}

// The VM keeps running between the calls of one turn. Stop it when the turn
// ends, even from a step that did not open it.
async function stopSandbox(session: PhaseSession, deps: PreparationDependencies, opened: OpenedSandbox): Promise<void> {
  if (!opened.sandbox && !session.state.sandboxId) return;
  try {
    const sandbox = opened.sandbox ?? await deps.sandbox.get({ name: session.state.sandboxId!, resume: false, signal: AbortSignal.timeout(10_000) });
    // A stop can create/evict snapshots. If the policy cannot be saved (including
    // quota/API errors), do not explicitly stop under the old destructive policy.
    await sandbox.update(PREPARATION_SNAPSHOTS, { signal: AbortSignal.timeout(10_000) });
    if (opened.sandbox || sandbox.status === "running") await sandbox.stop({ signal: AbortSignal.timeout(10_000) });
  } catch { throw new FatalError("Preparation sandbox retention/stop uncertain; explicit recovery required"); }
}

function exhausted(session: PhaseSession, turn: NonNullable<PhaseSession["state"]["activeTurn"]>): FatalError {
  const spent = turn.steps >= 8 ? "step limit reached" : "turn time spent";
  return new FatalError(`Preparation budget exhausted without a final response (${session.state.phase}/${session.state.seat}, ${turn.steps}/8 steps, ${spent}); explicit recovery required`);
}

// One bounded unit of preparation: start the next model call in the VM and wait
// for it a while, or wait a while more for the call in flight. Returns the draft
// once preparation is complete, undefined while it is under way. Every unit is
// checkpointed, so each runs in a workflow step of its own.
export async function advancePreparation(session: PhaseSession, deps: PreparationDependencies = { sandbox: Sandbox, bind: saveSandboxBinding }, opened: OpenedSandbox = {}, waitMs = PREPARATION_WAIT_MS): Promise<string | undefined> {
  // A lost launch/get/wait may already have executed. Do not enter legacy
  // restart or its cleanup/save catch for an explicitly generational request.
  if (deps.writer) throw new FatalError("Generational preparation blocked: command launch/retry and result reconciliation are not verified");
  const turn = session.state.activeTurn!;
  const complete = async () => {
    await session.finish();
    await stopSandbox(session, deps, opened);
    return turn.draft!;
  };
  const native = nativeDefinitions(session);
  try {
    if (turn.done && !turn.preparationCommand) return await complete();
    let command: Awaited<ReturnType<Sandbox["getCommand"]>>;
    if (turn.preparationCommand) {
      const sandbox = await openSandbox(session, deps, opened);
      try { command = await sandbox.getCommand(turn.preparationCommand.id); }
      catch (error) { return await restart(error); }
    } else {
      // A native call that has no time left files nothing; the case goes on.
      if (native && Date.parse(turn.expiresAt) - Date.now() <= NATIVE_CALL_MARGIN_MS + 5000) return await timedOut();
      // A replay cannot replenish a spent checkpoint.
      if (turn.steps >= 8 || Date.now() >= Date.parse(turn.expiresAt)) throw exhausted(session, turn);
      const sandbox = await openSandbox(session, deps, opened);
      if (!turn.preparationBound) {
        await deps.bind(session.caseId, sandbox.name, {
          phase: session.state.phase, seat: session.state.seat, sessionKey: session.key, phaseSessionId: session.state.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), revoked: false, model: session.state.model, gatewayTools: native ?? preparationDefinitions(session.state.phase),
          // A native research report carries every quote: its call has no output cap.
          ...(native ? { maxOutputTokens: null } : {}),
          activeTurn: { id: turn.id, expiresAt: turn.expiresAt, remainingRequests: 60 },
        });
        turn.preparationBound = true;
        await session.save();
      }
      await sandbox.runCommand({ cmd: "mkdir", args: ["-p", "/workspace/scratch"], timeoutMs: 5000 });
      const callId = `${turn.id}:${turn.steps}`;
      const resultPath = `/workspace/result-${callId.replaceAll(":", "-")}.json`;
      const remainingMs = Math.max(1, Date.parse(turn.expiresAt) - Date.now());
      // Reserve the last step, and the synthesis time, for a real final response.
      const toolChoice = native ? "auto" : turn.preparationToolChoice ?? (turn.steps === 7 || remainingMs <= PREPARATION_SYNTHESIS_MS + PREPARATION_TOOL_STEP_MS ? "none" : "auto");
      // The broker deduplicates by call ID and request hash. A replay must not
      // change that request just because less time remains after interruption.
      turn.preparationToolChoice = toolChoice;
      await session.save();
      // A native call has no synthesis after it: it may use the turn's time.
      const commandTimeoutMs = native ? Math.max(1, remainingMs - NATIVE_CALL_MARGIN_MS + 5000)
        : Math.max(1, Math.min(165_000, toolChoice === "auto" ? remainingMs - PREPARATION_SYNTHESIS_MS : remainingMs));
      const timeoutMs = native ? Math.max(1, remainingMs - NATIVE_CALL_MARGIN_MS) : Math.max(1, Math.min(150_000, commandTimeoutMs - 5000));
      await sandbox.writeFiles([{ path: "/workspace/task.json", content: JSON.stringify({ caseId: session.caseId, callId, model: session.state.model, system: session.state.system, messages: session.state.messages, tools: native ?? preparationDefinitions(session.state.phase), toolChoice, timeoutMs, ...(native ? { maxOutputTokens: null } : {}), resultPath }) }]);
      command = await sandbox.runCommand({ cmd: "node", args: ["--import", "/opt/evidence-harness/node_modules/tsx/dist/loader.mjs", "/opt/evidence-harness/instruction-agent.ts", "/workspace/task.json"], cwd: "/workspace", timeoutMs: commandTimeoutMs, detached: true });
      turn.preparationCommand = { id: command.cmdId, resultPath };
      await session.save();
    }
    const waiting = AbortSignal.timeout(waitMs);
    let exitCode: number;
    try { exitCode = (await command.wait({ signal: waiting })).exitCode; }
    catch (error) {
      if (waiting.aborted) return undefined;
      return await restart(error);
    }
    if (exitCode !== 0) throw new Error(`Brokered preparation failed (exit ${exitCode}); refusing independent processing fallback`);
    const bytes = await opened.sandbox!.readFileToBuffer({ path: turn.preparationCommand!.resultPath });
    if (!bytes || bytes.byteLength > 2_000_000) throw new Error("Preparation checkpoint unavailable");
    const result = JSON.parse(bytes.toString("utf8")) as { messages: ModelMessage[]; text: string; finishReason: string };
    if (!Array.isArray(result.messages) || result.messages.some((message) => message.role !== "assistant" && message.role !== "tool")) throw new Error("Invalid preparation messages");
    // One native call is the whole preparation: its report, possibly empty,
    // goes to the decision. A timeout files nothing instead of failing the case.
    if (native) {
      delete turn.preparationToolChoice;
      delete turn.preparationCommand;
      if (result.finishReason === "timeout") return await timedOut();
      turn.draft = result.text;
      turn.done = true;
      await session.append(result.messages);
      return await complete();
    }
    // A call that requested tools and ran out of time spends its step without
    // output; the synthesis still follows. A synthesis that runs out cannot.
    const continues = result.finishReason === "tool-calls" || (result.finishReason === "timeout" && turn.preparationToolChoice === "auto");
    turn.draft = result.text;
    turn.done = result.finishReason === "stop" && Boolean(result.text.trim());
    delete turn.preparationToolChoice;
    delete turn.preparationCommand;
    await session.append(result.messages);
    if (!continues && !turn.done) throw new FatalError("Preparation ended without a complete final response; explicit recovery required");
    if (turn.done) return await complete();
    if (turn.steps >= 8 || Date.now() >= Date.parse(turn.expiresAt)) throw exhausted(session, turn);
    return undefined;
  } catch (error) {
    // Dropping the active-turn checkpoint suspends grants before the VM stops.
    // The persistent VM may resume next turn, but its grant cannot.
    if (session.state.activeTurn) { delete session.state.activeTurn; await session.save(); }
    try { await stopSandbox(session, deps, opened); }
    catch (stopError) { console.warn("Could not safely stop preparation sandbox:", stopError); }
    throw error;
  }

  async function timedOut(): Promise<string> {
    turn.draft = "";
    turn.timedOut = true;
    turn.done = true;
    await session.save();
    return await complete();
  }

  // The VM stopped or lost the call in flight: start the same call again. Its
  // call ID and tool choice are unchanged, so the broker reuses a paid generation.
  async function restart(error: unknown): Promise<undefined> {
    console.warn("Preparation call lost; starting it again:", error instanceof Error ? error.message : error);
    delete turn.preparationCommand;
    await session.save();
    return undefined;
  }
}

// Runs every unit of a preparation turn in this process (tests and scripts).
export async function prepareInSandbox(session: PhaseSession, deps: PreparationDependencies = { sandbox: Sandbox, bind: saveSandboxBinding }): Promise<string> {
  const opened: OpenedSandbox = {};
  for (;;) {
    const draft = await advancePreparation(session, deps, opened);
    if (draft !== undefined) return draft;
  }
}

type CleanupDependencies = { sandbox: Pick<typeof Sandbox, "get" | "list">; names: (caseId: string) => Promise<string[]> };

export { SandboxCleanupBlockedError } from "../lib/sandbox-cleanup.ts";

// No release protocol currently proves the complete reference set AND writer
// inactivity. Terminal status, absent bindings/tags, cancellation, leases and
// new fencing cannot authorize remote deletion, even under a case-row lock.
// Keep the signature for legacy workflow replay and cleanup callbacks. Do not
// query the store here: administrative cleanup may already hold its row lock.
export async function deleteCaseSandboxes(_caseId: string, _deps: CleanupDependencies = { sandbox: Sandbox, names: caseSandboxNames }): Promise<void> {
  assertSandboxCleanupSafe();
}

// Validate the entire operation before ANY removal, including aliases. A
// no-op injected remover is not evidence of safe release. Never swallow a
// cleanup error here: administrative transactions must retain their references.
export function withSandboxCleanup(deleteBlobs: (ids: string[]) => Promise<void>, remove: (caseId: string) => Promise<void> = deleteCaseSandboxes) {
  return async (ids: string[]): Promise<void> => {
    if (!ids.length) return;
    assertSandboxCleanupSafe();
    for (const id of ids) await remove(id);
    await deleteBlobs(ids);
  };
}

type SweepDependencies = { sandbox: Pick<typeof Sandbox, "get" | "list">; caseStatus: (caseId: string) => Promise<string | undefined> };

// The same missing proof applies to resolved, failed, deleted/renamed and
// truncated-tag cases. No status cache/TOCTOU or provider enumeration is needed
// for this conservative block. Return only actually deleted names: always none.
export async function sweepCaseSandboxes(_deps?: SweepDependencies): Promise<string[]> {
  console.warn(new SandboxCleanupBlockedError().message);
  return [];
}
