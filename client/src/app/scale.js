// Skalierungsstufen für die Legende (nur Labels)
//
// Best Practices:
// - Gekapselte Logik zur Auswahl eines passenden Maßstabs

export const ScaleTiers = (() => {
  const toPretty = (km) => {
    const AU = 149597870.7, LY = 9.4607e12, MPC = 3.085677581e19, GPC = MPC * 1000;
    if (km < 1e6) return `${Math.round(km).toLocaleString('de-DE')} km`;
    if (km < AU * 0.8) return `${(km / 1e6).toFixed(2)} Mio. km`;
    if (km < LY * 0.8) return `${(km / AU).toFixed(2)} AE`;
    if (km < MPC * 0.8) return `${(km / LY).toFixed(2)} Lj`;
    if (km < GPC * 0.8) return `${(km / MPC).toFixed(2)} Mpc`;
    return `${(km / GPC).toFixed(2)} Gpc`;
  };
  const tiers = [
    { name: 'Erde', km: 12700 },
    { name: 'Magnetosphäre', km: 63000 },
    { name: 'Mondbahn', km: 770000 },
    { name: 'Erdbahn', km: 3e8 },
    { name: 'Inneres Sonnensystem', km: 6 * 149597870.7 },
    { name: 'Äußeres Sonnensystem', km: 60 * 149597870.7 },
    { name: 'Kuipergürtel', km: 96 * 149597870.7 },
    { name: 'Scattered Disk', km: 200 * 149597870.7 },
    { name: 'Heliosphäre', km: 240 * 149597870.7 },
    { name: 'Oortsche Wolke', km: 150000 * 149597870.7 },
    { name: 'Sonnensystem', km: 3 * 9.4607e12 },
    { name: 'Lokale Interstellare Wolke', km: 30 * 9.4607e12 },
    { name: 'Lokale Blase', km: 300 * 9.4607e12 },
    { name: 'Gouldscher Gürtel', km: 1150 * 9.4607e12 },
    { name: 'Orionarm', km: 10000 * 9.4607e12 },
    { name: 'Galaktische Umlaufbahn', km: 56000 * 9.4607e12 },
    { name: 'Milchstraße', km: 100000 * 9.4607e12 },
    { name: 'Milchstraße + Satelliten', km: 1.64e6 * 9.4607e12 },
    { name: 'Lokale Gruppe', km: 9e6 * 9.4607e12 },
    { name: 'Virgo‑Superhaufen', km: 1e8 * 9.4607e12 },
    { name: 'Laniakea', km: 5e8 * 9.4607e12 },
    { name: 'Filament', km: 9e8 * 9.4607e12 },
    { name: 'Beobachtbares Universum', km: 9.2e10 * 9.4607e12 },
  ].map(t => ({ ...t, pretty: toPretty(t.km) }));

  const KM_PER_WU = 1e3;
  function pick(viewWidthWU) {
    const spanKm = viewWidthWU * KM_PER_WU;
    let best = tiers[0], bestErr = Infinity;
    for (const t of tiers) { const err = Math.abs(t.km - spanKm); if (err < bestErr) { best = t; bestErr = err; } }
    return best;
  }
  return { pick };
})();
