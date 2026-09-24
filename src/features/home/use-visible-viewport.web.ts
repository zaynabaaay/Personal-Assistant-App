import { useEffect, useState } from 'react';

export type VisibleViewport = {
  height: number;
  top: number;
};

export function useVisibleViewport() {
  const [viewport, setViewport] = useState<VisibleViewport | null>(null);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    const root = document.documentElement;
    const body = document.body;
    const appRoot = document.getElementById('root');
    const originalStyles = new Map(
      [root, body, appRoot]
        .filter((element): element is HTMLElement => element !== null)
        .map((element) => [element, element.style.cssText]),
    );

    root.style.height = '100%';
    root.style.overflow = 'hidden';
    body.style.height = '100%';
    body.style.inset = '0';
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
    body.style.position = 'fixed';
    body.style.width = '100%';

    if (appRoot) {
      appRoot.style.height = '100%';
      appRoot.style.overflow = 'hidden';
      appRoot.style.width = '100%';
    }

    const updateViewport = () => {
      const nextViewport = {
        height: Math.round(visualViewport?.height ?? window.innerHeight),
        top: Math.round(visualViewport?.pageTop ?? visualViewport?.offsetTop ?? window.scrollY),
      };

      setViewport((current) =>
        current?.height === nextViewport.height && current.top === nextViewport.top
          ? current
          : nextViewport,
      );
    };

    updateViewport();
    window.addEventListener('orientationchange', updateViewport);
    window.addEventListener('resize', updateViewport);
    visualViewport?.addEventListener('resize', updateViewport);
    visualViewport?.addEventListener('scroll', updateViewport);

    return () => {
      window.removeEventListener('orientationchange', updateViewport);
      window.removeEventListener('resize', updateViewport);
      visualViewport?.removeEventListener('resize', updateViewport);
      visualViewport?.removeEventListener('scroll', updateViewport);
      originalStyles.forEach((cssText, element) => {
        element.style.cssText = cssText;
      });
    };
  }, []);

  return viewport;
}
