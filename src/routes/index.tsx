import { createFileRoute, getRouteApi, ClientOnly } from "@tanstack/react-router";

import { DiscoverySection } from "@/components/home/discovery-section";
import { HomeHero } from "@/components/home/home-hero";
import { RecommendSection } from "@/components/home/recommend-section";
import { messagesFor } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

export const Route = createFileRoute("/")({ ssr: true, component: Home });

function Home() {
  const { lang } = rootRoute.useSearch();
  const copy = messagesFor(lang);

  return (
    <div className="home">
      <HomeHero copy={copy} lang={lang} />
      <ClientOnly
        fallback={<span aria-hidden="true" className="block h-0 overflow-hidden" />}
      >
        <RecommendSection />
      </ClientOnly>
      <DiscoverySection copy={copy} lang={lang} />
    </div>
  );
}
