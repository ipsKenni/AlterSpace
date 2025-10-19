// Einstiegspunkt der Anwendung
//
// Best Practices:
// - Minimal halten; nur Bootstrapping

import './styles/main.css';
import { UniverseApp } from './app/app.js';

const canvas = document.getElementById('universe');
// Defensiv: Falls das Script vor dem DOM geladen wird
if (canvas) {
  // Prevent accidental text selection or scrolling on touch
  canvas.setAttribute('tabindex', '-1');
  new UniverseApp(canvas);
} else {
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.getElementById('universe');
    if (c) c.setAttribute('tabindex', '-1');
    new UniverseApp(c);
  });
}
