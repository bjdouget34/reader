// Page-turn motion, shared by both engines.
//
// The first attempt at this leaned on `scroll-behavior: smooth`, since an epub
// paginates by scrolling one column and the browser will happily animate that
// for free. It looked right about half the time. Turning inside a chapter is a
// scroll and animated; turning past the end of one makes epub.js render a fresh
// section and jump to position zero, and there is no scroll to animate at all.
// In a book cut into many short files -- front matter, a file per chapter --
// most turns are boundaries, so most turns did nothing.
//
// So the motion no longer depends on how the turn happens underneath. The
// element is moved out against the direction of travel, the page changes while
// it is out of sight, and it settles back from the far side. A scroll, a new
// section and a re-rendered pdf page all look the same.

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

const CLASSES = ['turning', 'leave-next', 'leave-prev', 'enter-next', 'enter-prev'];

// Matches the transition duration in css/app.css. Long enough to read as
// movement, short enough not to sit between the reader and the next page.
const LEAVE_MS = 150;

export function makeTurnAnimator(element) {
  return async function animateTurn(direction, work) {
    if (!element || reducedMotion?.matches) return work();

    const leaving = direction === 'next' ? 'leave-next' : 'leave-prev';
    const arriving = direction === 'next' ? 'enter-next' : 'enter-prev';

    element.classList.add('turning', leaving);
    await new Promise(resolve => setTimeout(resolve, LEAVE_MS));
    element.classList.remove(leaving);

    // The arriving class carries `transition: none`, so the element jumps to the
    // far side rather than sliding there.
    element.classList.add(arriving);
    try {
      return await work();
    } finally {
      // Two frames: the first lets the browser take up the offset untransitioned,
      // the second removes the class so it animates home.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        element.classList.remove(arriving, 'turning');
      }));
    }
  };
}

// Tearing down mid-turn must not leave a page parked off screen.
export function clearTurnClasses(element) {
  element?.classList.remove(...CLASSES);
}
