import { Link, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { clientFailureSchema } from "@/shared/client-failure";

export function DiscoveryError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const failure = clientFailureSchema.safeParse(error);

  return (
    <div className="discovery-empty" role="alert">
      <h1 className="font-display text-3xl">Discovery is unavailable</h1>
      <p>{failure.success ? failure.data.message : "Discovery could not load. Please retry."}</p>
      <button type="button" onClick={() => void router.invalidate()}>
        Try again
      </button>
      <Link to="/" search={{ lang: "en" }}>
        Return home
      </Link>
    </div>
  );
}
