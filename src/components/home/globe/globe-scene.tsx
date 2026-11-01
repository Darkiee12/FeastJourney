import { OrthographicCamera } from "@react-three/drei";
import { Canvas, useFrame, useThree, type RootState, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";

import { FOOD_LOCATIONS, type FoodLocation } from "@/components/home/globe/food-locations";
import {
  AXIAL_TILT_RADIANS,
  FACING_COSINE_THRESHOLD,
  GLOBE_RADIUS,
  SPIN_ROLL_RADIANS,
  facingCosine,
  latLonToVec3,
  type GlobeOverlayBridge,
} from "@/components/home/globe/geo-utils";
import { GlobeAnimator } from "@/components/home/globe/globe-animator";
import { GlobeFallback } from "@/components/home/globe/globe-fallback";
import { GlobeFoodOverlay } from "@/components/home/globe/globe-food-overlay";
import { useGlobeAssets } from "@/components/home/globe/use-globe-assets";
import {
  useGlobeDishes,
  type GlobeHoverState,
  type GlobePopupNodes,
} from "@/components/home/globe/use-globe-dishes";
import { usePrefersReducedMotion } from "@/components/home/globe/use-prefers-reduced-motion";
import type { Locale, Messages } from "@/shared/i18n";

const PIN_SIZE_PX = 14;
const RING_SCALE = 1.002;
const GLOW_SCALE = 1.16;

/**
 * Raycast hit radius around each pin in world units. The globe radius is 1,
 * so this is a generous hover target without covering neighboring cities.
 */
const PIN_HOVER_THRESHOLD = 0.045;

/**
 * Module-level raycaster write: the threshold lives outside React state, so
 * this helper keeps the hook-arg mutation out of the component body.
 */
function applyPointsThreshold(raycaster: THREE.Raycaster, value: number): number {
  const previous = raycaster.params.Points.threshold;
  raycaster.params.Points.threshold = value;

  return previous;
}

function DishAnchor({
  dish,
  anchorsRef,
}: {
  dish: FoodLocation;
  anchorsRef: RefObject<Map<string, THREE.Object3D | null>>;
}) {
  const position = useMemo((): [number, number, number] => {
    const point = new THREE.Vector3();
    latLonToVec3(dish.latitude, dish.longitude, GLOBE_RADIUS * 1.01, point);

    const tuple: [number, number, number] = [point.x, point.y, point.z];

    return tuple;
  }, [dish]);

  return (
    <object3D
      position={position}
      ref={(node) => {
        anchorsRef.current.set(dish.id, node);
      }}
    />
  );
}

/** Generous pin hover targets: the default Points threshold covers too much. */
function PinRaycastThreshold() {
  const raycaster = useThree((state) => state.raycaster);

  useEffect(() => {
    const previous = applyPointsThreshold(raycaster, PIN_HOVER_THRESHOLD);

    return () => {
      applyPointsThreshold(raycaster, previous);
    };
  }, [raycaster]);

  return null;
}

function FrameloopGate() {
  const set = useThree((state) => state.set);
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    const element = gl.domElement;
    let inView = true;
    let pageVisible = document.visibilityState !== "hidden";

    const apply = () => {
      set({ frameloop: inView && pageVisible ? "always" : "never" });
    };

    apply();

    const observer = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? true;
        apply();
      },
      { threshold: 0.02 },
    );

    observer.observe(element);

    const onVisibility = () => {
      pageVisible = document.visibilityState !== "hidden";
      apply();
    };

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [gl, set]);

  return null;
}

/**
 * Reports the first rendered frame once so the canvas wrapper can fade in.
 * The earth texture is created synchronously in useGlobeAssets before this
 * first frame, so first-frame-ready implies the texture is already uploaded.
 */
function FirstFrameReady({ onReady }: { onReady: () => void }) {
  const done = useRef(false);

  useFrame(() => {
    if (!done.current) {
      done.current = true;
      onReady();
    }
  });

  return null;
}

function GlobeWorld({
  bridgeRef,
  popupsRef,
  hoverRef,
  onActiveDishes,
  onHoverDish,
  onOpenPreview,
  onReady,
}: {
  bridgeRef: RefObject<GlobeOverlayBridge>;
  popupsRef: RefObject<GlobePopupNodes>;
  hoverRef: RefObject<GlobeHoverState>;
  onActiveDishes: (ids: Array<string>) => void;
  onHoverDish: (id: string | null) => void;
  onOpenPreview: (dish: FoodLocation) => void;
  onReady: () => void;
}) {
  // Every catalog anchor renders a pin: no sampling cap. The pin layer
  // and the popup scheduler share the full set; all anchors stay mounted
  // so an open popup never loses its anchor.
  const visibleDishes: Array<FoodLocation> = FOOD_LOCATIONS;

  const {
    layout,
    halfWidth,
    initialSpin,
    texture,
    atmosphere,
    atmosphereGlow,
    pinTexture,
    dotPositions,
  } = useGlobeAssets(visibleDishes);

  const spinRef = useRef<THREE.Group | null>(null);
  const anchorsRef = useRef<Map<string, THREE.Object3D | null>>(new Map());
  const camera = useThree((state) => state.camera);

  const facingTemps = useMemo(
    () => ({ world: new THREE.Vector3(), center: new THREE.Vector3() }),
    [],
  );

  // Raycast hits ignore globe occlusion, so only front-facing pins answer
  // hover and tap. Backside hits clear the hover instead of pinning a popup
  // the animator would immediately hide.
  const dishFacesCamera = useCallback(
    (id: string): boolean => {
      const anchor = anchorsRef.current.get(id);

      if (!anchor) {
        return false;
      }

      anchor.getWorldPosition(facingTemps.world);
      facingTemps.center.set(layout.centerX, layout.centerY, 0);

      return (
        facingCosine(facingTemps.world, facingTemps.center, camera.position) >
        FACING_COSINE_THRESHOLD
      );
    },
    [camera, facingTemps, layout],
  );

  const handlePointsMove = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (event.nativeEvent.pointerType === "touch") {
        return;
      }

      const index = event.index;

      if (index === undefined) {
        onHoverDish(null);

        return;
      }

      const dish = FOOD_LOCATIONS[index];

      if (!dish || !dishFacesCamera(dish.id)) {
        onHoverDish(null);

        return;
      }

      onHoverDish(dish.id);
    },
    [dishFacesCamera, onHoverDish],
  );

  const handlePointsOut = useCallback(() => {
    onHoverDish(null);
  }, [onHoverDish]);

  const handlePointsClick = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      // Dragging the globe must not open a popup: R3F reports the pointer
      // travel in `delta`, so taps (small delta) open the preview while
      // drags (large delta) only rotate the planet.
      if (event.delta > 5) {
        return;
      }

      const index = event.index;

      if (index === undefined) {
        return;
      }

      const dish = FOOD_LOCATIONS[index];

      if (!dish || !dishFacesCamera(dish.id)) {
        return;
      }

      onOpenPreview(dish);
    },
    [dishFacesCamera, onOpenPreview],
  );

  return (
    <>
      <OrthographicCamera
        makeDefault
        manual
        left={-halfWidth}
        right={halfWidth}
        top={layout.frustumHalfHeight}
        bottom={-layout.frustumHalfHeight}
        near={0.1}
        far={60}
        position={[0, 0, 10]}
      />
      <hemisphereLight args={["#bfd9ff", "#0a1633", 0.9]} />
      <directionalLight position={[-4, 3, 6]} intensity={2.2} color="#fff5e6" />

      <group position={[layout.centerX, layout.centerY, 0]}>
        <group rotation-x={AXIAL_TILT_RADIANS}>
          <group rotation-z={SPIN_ROLL_RADIANS}>
            <group ref={spinRef} rotation-y={initialSpin}>
              <mesh>
                <sphereGeometry args={[GLOBE_RADIUS, 64, 64]} />
                <meshStandardMaterial map={texture} roughness={1} metalness={0} />
              </mesh>

              <points
                frustumCulled={false}
                onPointerMove={handlePointsMove}
                onPointerOut={handlePointsOut}
                onClick={handlePointsClick}
              >
                <bufferGeometry>
                  <bufferAttribute attach="attributes-position" args={[dotPositions, 3]} />
                </bufferGeometry>
                <pointsMaterial
                  size={PIN_SIZE_PX}
                  sizeAttenuation={false}
                  map={pinTexture}
                  transparent
                  alphaTest={0.4}
                  depthWrite={false}
                />
              </points>

              {FOOD_LOCATIONS.map((dish) => (
                <DishAnchor key={dish.id} dish={dish} anchorsRef={anchorsRef} />
              ))}
            </group>
          </group>
        </group>

        <mesh scale={GLOW_SCALE} material={atmosphereGlow}>
          <sphereGeometry args={[GLOBE_RADIUS, 48, 48]} />
        </mesh>

        <mesh scale={RING_SCALE} material={atmosphere}>
          <sphereGeometry args={[GLOBE_RADIUS, 48, 48]} />
        </mesh>
      </group>

      <GlobeAnimator
        spinRef={spinRef}
        anchorsRef={anchorsRef}
        bridgeRef={bridgeRef}
        popupsRef={popupsRef}
        hoverRef={hoverRef}
        visibleDishes={visibleDishes}
        onActiveDishes={onActiveDishes}
        layout={layout}
      />
      <PinRaycastThreshold />
      <FirstFrameReady onReady={onReady} />
      <FrameloopGate />
    </>
  );
}

/**
 * Lazy, client-only globe experience: WebGL scene plus the DOM food overlay.
 * Owns the single static layer (Stage C): GlobeFallback stays mounted over
 * WebGL and crossfades out 700ms after the first frame, then unmounts.
 */
export function GlobeScene({
  copy,
  lang,
  bridgeRef,
}: {
  copy: Messages;
  lang: Locale;
  bridgeRef: RefObject<GlobeOverlayBridge>;
}) {
  const reducedMotion = usePrefersReducedMotion();

  const {
    actives,
    preview,
    announcement,
    hoverRef,
    handleActiveDishes,
    handleHoverDish,
    handleOpenPreview,
    handleClosePreview,
    handleShowAnother,
  } = useGlobeDishes(bridgeRef, copy);

  const popupsRef = useRef<GlobePopupNodes>(new Map());
  const [ready, setReady] = useState(false);
  const [showStatic, setShowStatic] = useState(true);
  const [webglFailed, setWebglFailed] = useState(false);

  const handleReady = useCallback(() => {
    setReady(true);
  }, []);

  // Stage D: a lost GL context (blocked GPU, exhausted contexts) never yields
  // frames, so FirstFrameReady would never fire and leave an empty slot.
  // Listen for the canvas context-loss event and fall back to the static
  // planet permanently instead.
  const handleCreated = useCallback((state: RootState) => {
    state.gl.domElement.addEventListener(
      "webglcontextlost",
      (event) => {
        event.preventDefault();
        setWebglFailed(true);
      },
      { once: true },
    );
  }, []);

  useEffect(() => {
    let timer: number | undefined;

    if (ready) {
      timer = window.setTimeout(() => {
        setShowStatic(false);
      }, 700);
    }

    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [ready]);

  if (reducedMotion) {
    return <GlobeFallback label={copy.globeStaticLabel} lang={lang} />;
  }

  if (webglFailed) {
    return <GlobeFallback label={copy.globeStaticLabel} lang={lang} />;
  }

  return (
    <>
      {showStatic ? (
        <div
          className={`absolute inset-0 transition-opacity duration-700 ease-out ${ready ? "opacity-0" : "opacity-100"}`}
        >
          <GlobeFallback label={copy.globeStaticLabel} lang={lang} />
        </div>
      ) : null}
      <div
        aria-hidden="true"
        className={`absolute inset-0 transition-opacity duration-700 ease-out ${ready ? "opacity-100" : "opacity-0"}`}
      >
        <Canvas
          orthographic
          dpr={[1, 2]}
          frameloop="always"
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
          camera={{ position: [0, 0, 10], near: 0.1, far: 60 }}
          onCreated={handleCreated}
        >
          <GlobeWorld
            bridgeRef={bridgeRef}
            popupsRef={popupsRef}
            hoverRef={hoverRef}
            onActiveDishes={handleActiveDishes}
            onHoverDish={handleHoverDish}
            onOpenPreview={handleOpenPreview}
            onReady={handleReady}
          />
        </Canvas>
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-space-deep/40 to-space-deep/25"
      />

      <GlobeFoodOverlay
        copy={copy}
        lang={lang}
        bridgeRef={bridgeRef}
        popupsRef={popupsRef}
        actives={actives}
        preview={preview}
        announcement={announcement}
        onOpenPreview={handleOpenPreview}
        onClosePreview={handleClosePreview}
        onShowAnother={handleShowAnother}
        onHoverDish={handleHoverDish}
      />
    </>
  );
}
