// Einstiegspunkt der Anwendung – bootstrapped via Vite und abgesichert durch Server-Registrierung

import './styles/main.css';
import { UniverseApp } from './app/app.ts';

interface ServerConfig {
  seed: string;
  session: { name: string } | null;
}

interface RegistrationResult {
  token: string;
  name: string;
}

const AUTH_TOKEN_KEY = 'authToken';
const PLAYER_NAME_KEY = 'playerName';

async function fetchConfig(token: string | null): Promise<ServerConfig> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch('/api/config', { headers });
  if (!response.ok) {
    throw new Error(`Konfigurationsabruf fehlgeschlagen (${response.status})`);
  }
  return (await response.json()) as ServerConfig;
}

async function registerPlayer(name: string): Promise<RegistrationResult> {
  const response = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  let payload: { token?: string; name?: string; error?: string } | null;
  try {
    payload = (await response.json()) as { token?: string; name?: string; error?: string };
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || typeof payload.token !== 'string' || typeof payload.name !== 'string') {
    const message = payload?.error || response.statusText || 'Registrierung fehlgeschlagen';
    throw new Error(message);
  }
  return { token: payload.token, name: payload.name };
}

function getElementById<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function ensureCanvas(): HTMLCanvasElement {
  const canvas = getElementById<HTMLCanvasElement>('universe');
  if (!canvas) {
    throw new Error('Canvas-Element nicht gefunden.');
  }
  return canvas;
}

async function promptRegistration(defaultName: string): Promise<RegistrationResult> {
  const overlay = getElementById<HTMLDivElement>('authOverlay');
  const form = getElementById<HTMLFormElement>('authForm');
  const input = getElementById<HTMLInputElement>('authName');
  const errorBox = getElementById<HTMLParagraphElement>('authError');
  if (!overlay || !form || !input) {
    throw new Error('Registrierungsdialog nicht verfügbar.');
  }

  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  if (errorBox) {
    errorBox.textContent = '';
  }
  input.value = defaultName || '';
  setTimeout(() => input.focus(), 50);

  return new Promise((resolve) => {
    const submitButton = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;

    const cleanup = () => {
      form.removeEventListener('submit', submitHandler);
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      if (submitButton) {
        submitButton.disabled = false;
      }
    };

    const submitHandler = async (event: Event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (name.length < 3) {
        if (errorBox) {
          errorBox.textContent = 'Name muss mindestens 3 Zeichen haben.';
        }
        return;
      }
      if (submitButton) {
        submitButton.disabled = true;
      }
      try {
        const result = await registerPlayer(name);
        cleanup();
        resolve(result);
      } catch (error) {
        if (submitButton) {
          submitButton.disabled = false;
        }
        if (errorBox) {
          errorBox.textContent = error instanceof Error ? error.message : 'Registrierung fehlgeschlagen';
        }
      }
    };

    form.addEventListener('submit', submitHandler);
  });
}

async function bootstrap(): Promise<void> {
  const canvas = ensureCanvas();
  let storedToken: string | null = null;
  let storedName: string | null = null;

  try {
    storedToken = localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    storedToken = null;
  }
  try {
    storedName = localStorage.getItem(PLAYER_NAME_KEY);
  } catch {
    storedName = null;
  }

  let config: ServerConfig;
  try {
    config = await fetchConfig(storedToken);
  } catch (error) {
    console.error('[bootstrap] Konfigurationsabruf fehlgeschlagen:', error);
    alert('Server nicht erreichbar. Bitte später erneut versuchen.');
    return;
  }

  let activeToken = storedToken;
  let activeName = config.session?.name || storedName || '';

  if (!config.session || !activeToken) {
    const registration = await promptRegistration(activeName);
    activeToken = registration.token;
    activeName = registration.name;
    try {
      localStorage.setItem(AUTH_TOKEN_KEY, activeToken);
      localStorage.setItem(PLAYER_NAME_KEY, activeName);
    } catch {
      /* ignore storage errors */
    }
    try {
      config = await fetchConfig(activeToken);
    } catch (error) {
      console.error('[bootstrap] Konfigurationsabruf nach Registrierung fehlgeschlagen:', error);
    }
  }

  if (!config.seed) {
    throw new Error('Server lieferte keinen Seed.');
  }

  canvas.setAttribute('tabindex', '-1');
  new UniverseApp(canvas, {
    seed: config.seed,
    token: activeToken ?? '',
    playerName: activeName || config.session?.name || 'Du',
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
} else {
  void bootstrap();
}
