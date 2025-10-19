# Unendliches Universum – Projektstruktur

Das Projekt ist als pnpm‑Workspace mit getrennten Applikationen aufgeteilt:

- `client/` – Vite‑basierter Frontend‑Build (ESM‑Module unter `src/`), Entwicklungsserver & Production‑Build (`dist/`).
- `server/` – Node.js‑WebSocket/HTTP‑Server; liefert den gebauten Client aus `client/dist` aus.
- `pnpm-workspace.yaml` – Deklariert die Workspaces `client` und `server`.
- `package.json` (Root) – Gemeinsame Skripte für Entwicklung, Build und Start.

## Voraussetzungen

- Node.js ≥ 18
- pnpm ≥ 9 (`corepack enable` oder [Installationshinweise](https://pnpm.io/installation))

## Installation

```bash
pnpm install
```

## Entwicklung

Frontend (Vite Dev Server) und Backend werden separat gestartet:

```bash
pnpm dev:server   # startet den Node-Server auf Port 8080
pnpm dev:client   # startet Vite auf Port 5173
```

Die Weboberfläche ist anschließend unter http://localhost:5173 erreichbar.
Während der Entwicklung verbindet sich der Client weiterhin per WebSocket mit `ws://localhost:8080`.
Optional kann `client/.env.local` mit `VITE_SIGNAL_URL=ws://dein-host:port` angelegt werden, um einen anderen Signalisierungsendpunkt zu verwenden.

## Produktion

1. Build erstellen: `pnpm build`
2. Server starten: `pnpm start`

Der Server liefert dann die Dateien aus `client/dist` aus. Falls kein Build vorliegt, antwortet er mit HTTP 503 und weist auf den fehlenden Frontend‑Build hin.

## Ordnerübersicht Client

- `src/app/` – Anwendungskern (Modelle, Konstanten, Chunk-Management, Skalierung).
- `src/core/` – Grundlegende Utilities (Mathematik, PRNG, Kamera, Eingabe, Noise).
- `src/render/` – Canvas‑Renderer & Picking.
- `src/shared/`, `src/interior/`, `src/surface/`, `src/net/` – Spezialmodule für Interaktionen, Innenräume, Oberflächen & Netzwerkcode.
- `src/main.js` – Bootstrapping; importiert das globale Stylesheet.

## Ordnerübersicht Server

- `src/server.js` – Einstiegspunkt, HTTP + WebSocket + optional WebRTC Signalisierung.
- `package.json` – eigenständige Laufzeitabhängigkeiten (`ws`, `uuid`, optional `wrtc`).

## Nächste Schritte / Empfehlungen

- Automatisierte Tests ergänzen (z. B. Vitest für den Client, Jest oder Node-Test Runner für den Server).
- CI-Workflow (GitHub Actions) hinzufügen, um Build und Linting sicherzustellen.
- Environment-Variablen (z. B. `.env` via Vite/Node) für konfigurierbare URLs oder Feature-Flags einführen.
