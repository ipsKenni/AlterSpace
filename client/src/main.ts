// Einstiegspunkt der Anwendung – bootstrapped via Vite

import './styles/main.css';
import { UniverseApp } from './app/app.ts';

function initWithCanvas(canvas: Element | null): void {
  if (!(canvas instanceof HTMLCanvasElement)) {
    return;
  }
  canvas.setAttribute('tabindex', '-1');
  new UniverseApp(canvas);
}

const immediateCanvas = document.getElementById('universe');
if (immediateCanvas) {
  initWithCanvas(immediateCanvas);
} else {
  window.addEventListener('DOMContentLoaded', () => {
    initWithCanvas(document.getElementById('universe'));
  });
}
