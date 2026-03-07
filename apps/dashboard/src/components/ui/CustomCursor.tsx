'use client';

import { useEffect, useRef, memo } from 'react';

const CustomCursor = memo(() => {
  const cursorRef = useRef<HTMLDivElement>(null);
  const mousePosition = useRef({ x: 0, y: 0 });
  const cursorPosition = useRef({ x: 0, y: 0 });
  const scale = useRef(1);
  const targetScale = useRef(1);
  const animationFrame = useRef<number>(0);
  const idleTimeout = useRef<NodeJS.Timeout | null>(null);
  const isVisible = useRef(false);

  useEffect(() => {
    if(window.innerWidth < 768) return;
    const handleMouseMove = (e: MouseEvent) => {
      mousePosition.current = { x: e.clientX, y: e.clientY };

      // Fade in if hidden
      if (!isVisible.current) {
        isVisible.current = true;
        if (cursorRef.current) cursorRef.current.style.opacity = '1';
      }

      // Reset idle timer
      if (idleTimeout.current) clearTimeout(idleTimeout.current);
      idleTimeout.current = setTimeout(() => {
        isVisible.current = false;
        if (cursorRef.current) cursorRef.current.style.opacity = '0';
      }, 2000); // hide after 2s of inactivity
    };

    const handleMouseLeave = () => {
      // Hide immediately
      isVisible.current = false;
      if (cursorRef.current) cursorRef.current.style.opacity = '0';
    };

    const handleMouseEnter = () => {
      // Fade in on re-enter
      isVisible.current = true;
      if (cursorRef.current) cursorRef.current.style.opacity = '1';
    };

    // Throttled hover detection
    const checkHover = () => {
      const element = document.elementFromPoint(
        mousePosition.current.x,
        mousePosition.current.y
      ) as HTMLElement | null;

      targetScale.current = element?.tagName === 'BUTTON' || element?.tagName === 'A' ? 1 : 0.5;

      setTimeout(checkHover, 100);
    };

    const animate = () => {
      // Smooth position
      const dx = mousePosition.current.x - cursorPosition.current.x;
      const dy = mousePosition.current.y - cursorPosition.current.y;
      cursorPosition.current.x += dx * 0.2;
      cursorPosition.current.y += dy * 0.2;

      // Smooth scale
      scale.current += (targetScale.current - scale.current) * 0.2;

      if (cursorRef.current) {
        cursorRef.current.style.transform = `translate(${cursorPosition.current.x - 16}px, ${cursorPosition.current.y - 16}px) scale(${scale.current})`;
      }

      animationFrame.current = requestAnimationFrame(animate);
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('mouseenter', handleMouseEnter);

    checkHover();
    animationFrame.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('mouseenter', handleMouseEnter);
      if (animationFrame.current) cancelAnimationFrame(animationFrame.current);
      if (idleTimeout.current) clearTimeout(idleTimeout.current);
    };
  }, []);

  return (
    <div
      ref={cursorRef}
      className="fixed w-8 h-8 bg-white rounded-full pointer-events-none z-[9999] mix-blend-difference will-change-transform transition-opacity duration-200"
      style={{ opacity: 0 }} // start hidden
    />
  );
});

// CustomCursor.displayName = 'CustomCursor';

const CustomCursorTwo = () => {
  return (<></>)
}

export default CustomCursorTwo;
// export default CustomCursor;
