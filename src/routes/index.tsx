import { createFileRoute, getRouteApi, ClientOnly } from "@tanstack/react-router";

import { DiscoverySection } from "@/components/home/discovery-section";
import { HomeHero } from "@/components/home/home-hero";
import { MobileHome } from "@/components/home/mobile/mobile-home";
import { RecommendSection } from "@/components/home/recommend-section";
import { useIsMaxMd } from "@/components/home/recommend/quiz-drawer";
import { messagesFor, type Locale, type Messages } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

export const Route = createFileRoute("/")({ ssr: true, component: Home });

function DesktopHome({ copy, lang }: { copy: Messages; lang: Locale }) {
  return (
    <div className="home">
      <HomeHero copy={copy} lang={lang} />
      <ClientOnly fallback={<span aria-hidden="true" className="block h-0 overflow-hidden" />}>
        <RecommendSection />
      </ClientOnly>
      <DiscoverySection copy={copy} lang={lang} />
    </div>
  );
}

function HomeSwitcher({ copy, lang }: { copy: Messages; lang: Locale }) {
  const isMobile = useIsMaxMd();

  return isMobile ? (
    <MobileHome copy={copy} lang={lang} />
  ) : (
    <DesktopHome copy={copy} lang={lang} />
  );
}

function Home() {
  const { lang } = rootRoute.useSearch();
  const copy = messagesFor(lang);

  return (
    <ClientOnly fallback={<DesktopHome copy={copy} lang={lang} />}>
      <HomeSwitcher copy={copy} lang={lang} />
    </ClientOnly>
  );
}
