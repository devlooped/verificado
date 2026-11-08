// Offline safety-guard tests ONLY: these are not PostgreSQL or lock evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { assertDedicatedContainer, assertLocalDockerEndpoint, type ContainerProof } from "../scripts/test-local-generational-operations.ts";

const own = { context: "desktop-linux", nonce: "execution", name: "fixture", image: "sha256:image", network: "fixture-net", networkId: "network", containerId: "container", started: Date.now() - 1000, parentPid: 1 };
function proof(): ContainerProof {
  return { id: "container", name: "/fixture", image: "sha256:image", labels: { "io.grokeado.generational-fixture": "execution" }, running: true, startedAt: new Date().toISOString(),
    mounts: [], tmpfs: { "/var/lib/postgresql/data": "rw", "/var/run/postgresql": "rw", "/tmp": "rw" }, privileged: false, readonly: true, binds: null,
    networkMode: "fixture-net", ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "25432" }] }, networks: { "fixture-net": { IPAddress: "172.30.0.2" } } };
}
test("fixture accepts local named pipe/socket and rejects remote Docker endpoints", () => {
  assertLocalDockerEndpoint("npipe:////./pipe/dockerDesktopLinuxEngine"); assertLocalDockerEndpoint("unix:///var/run/docker.sock");
  for (const endpoint of ["tcp://127.0.0.1:2375", "ssh://remote", "tcp://remote:2376", "npipe:////server/pipe/docker", "unix:///other/socket", ""]) assert.throws(() => assertLocalDockerEndpoint(endpoint));
});
test("fixture requires exact execution ownership, image, running state and creation time", () => {
  assert.deepEqual(assertDedicatedContainer(proof(), own), { port: 25432, address: "172.30.0.2" });
  for (const patch of [{ id: "other" }, { name: "/other" }, { image: "other" }, { labels: {} }, { running: false }, { startedAt: "2000-01-01" }]) assert.throws(() => assertDedicatedContainer({ ...proof(), ...patch }, own));
});
test("fixture rejects user/anonymous volumes, bind mounts and writable or privileged containers", () => {
  for (const patch of [{ mounts: [{ Type: "volume", Destination: "/var/lib/postgresql/data" }] }, { mounts: [{ Type: "bind", Destination: "/tmp" }] }, { binds: ["user-path:/tmp"] }, { tmpfs: {} }, { readonly: false }, { privileged: true }]) assert.throws(() => assertDedicatedContainer({ ...proof(), ...patch }, own));
});
test("fixture rejects non-loopback, duplicate/extra/malformed ports and additional networks", () => {
  const cases: ContainerProof["ports"][] = [{ "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "25432" }] }, { "5432/tcp": [{ HostIp: "::1", HostPort: "25432" }] }, { "5432/tcp": null }, { "5432/tcp": [] }, { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "65536" }] }, { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "25432" }], "80/tcp": null }, { "5432/tcp": [...proof().ports["5432/tcp"]!, ...proof().ports["5432/tcp"]!] }];
  for (const ports of cases) assert.throws(() => assertDedicatedContainer({ ...proof(), ports }, own));
  assert.throws(() => assertDedicatedContainer({ ...proof(), networks: { ...proof().networks, bridge: { IPAddress: "172.17.0.2" } } }, own));
  assert.throws(() => assertDedicatedContainer({ ...proof(), networkMode: "host" }, own));
  for (const IPAddress of ["8.8.8.8", "172.15.0.2", "10.999.0.2", "::1", ""]) assert.throws(() => assertDedicatedContainer({ ...proof(), networks: { "fixture-net": { IPAddress } } }, own));
});
