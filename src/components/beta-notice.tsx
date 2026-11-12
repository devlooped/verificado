export function BetaNotice({ signedIn }: { signedIn: boolean }) {
  return (
    <div>
      <p className="mt-5 leading-relaxed text-ink-soft">
        Che.bot está en beta. Para pedir una evaluación, enviá un correo a{" "}
        <a href="mailto:hola@che.bot" className="font-medium text-celeste-deep underline">hola@che.bot</a>.
      </p>
      {signedIn ? (
        <a href="/auth/logout?returnTo=/" className="mt-5 inline-block text-sm text-ink-soft underline">Cerrar sesión</a>
      ) : (
        <a href="/auth/login?returnTo=/" className="mt-5 inline-block text-sm text-ink-soft underline">Iniciá sesión</a>
      )}
    </div>
  );
}
