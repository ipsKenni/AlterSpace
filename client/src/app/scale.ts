// Skalierungsstufen für die Legende (nur Labels)
//
// Best Practices:
// - Gekapselte Logik zur Auswahl eines passenden Maßstabs

export interface ScaleTier {
  name: string;
  km: number;
  pretty: string;
}

const ScaleTiersInternal = (() => {
  const toPretty = (km: number): string => {
    const AU = 149_597_870.7;
    const LY = 9.4607e12;
    const MPC = 3.085_677_581e19;
    const GPC = MPC * 1000;
    if (km < 1e6) return `${Math.round(km).toLocaleString('de-DE')} km`;
    if (km < AU * 0.8) return `${(km / 1e6).toFixed(2)} Mio. km`;
    if (km < LY * 0.8) return `${(km / AU).toFixed(2)} AE`;
    if (km < MPC * 0.8) return `${(km / LY).toFixed(2)} Lj`;
    if (km < GPC * 0.8) return `${(km / MPC).toFixed(2)} Mpc`;
    return `${(km / GPC).toFixed(2)} Gpc`;
  };

  const tiers: ScaleTier[] = [
    { name: 'Erde', km: 12_700, pretty: '' },
    { name: 'Magnetosphäre', km: 63_000, pretty: '' },
    { name: 'Mondbahn', km: 770_000, pretty: '' },
    { name: 'Erdbahn', km: 3e8, pretty: '' },
    { name: 'Inneres Sonnensystem', km: 6 * 149_597_870.7, pretty: '' },
    { name: 'Äußeres Sonnensystem', km: 60 * 149_597_870.7, pretty: '' },
    { name: 'Kuipergürtel', km: 96 * 149_597_870.7, pretty: '' },
    { name: 'Scattered Disk', km: 200 * 149_597_870.7, pretty: '' },
    { name: 'Heliosphäre', km: 240 * 149_597_870.7, pretty: '' },
    { name: 'Oortsche Wolke', km: 150_000 * 149_597_870.7, pretty: '' },
    { name: 'Sonnensystem', km: 3 * 9.4607e12, pretty: '' },
    { name: 'Lokale Interstellare Wolke', km: 30 * 9.4607e12, pretty: '' },
    { name: 'Lokale Blase', km: 300 * 9.4607e12, pretty: '' },
    { name: 'Gouldscher Gürtel', km: 1_150 * 9.4607e12, pretty: '' },
    { name: 'Orionarm', km: 10_000 * 9.4607e12, pretty: '' },
    { name: 'Galaktische Umlaufbahn', km: 56_000 * 9.4607e12, pretty: '' },
    { name: 'Milchstraße', km: 100_000 * 9.4607e12, pretty: '' },
    { name: 'Milchstraße + Satelliten', km: 1.64e6 * 9.4607e12, pretty: '' },
    { name: 'Lokale Gruppe', km: 9e6 * 9.4607e12, pretty: '' },
    { name: 'Virgo‑Superhaufen', km: 1e8 * 9.4607e12, pretty: '' },
    { name: 'Laniakea', km: 5e8 * 9.4607e12, pretty: '' },
    { name: 'Filament', km: 9e8 * 9.4607e12, pretty: '' },
    { name: 'Beobachtbares Universum', km: 9.2e10 * 9.4607e12, pretty: '' },
  ].map((tier) => ({ ...tier, pretty: toPretty(tier.km) }));

  const KM_PER_WU = 1_000;

  const pick = (viewWidthWU: number): ScaleTier => {
    const defaultTier = tiers[0];
    if (!defaultTier) {
      throw new Error('Scale tiers configuration missing');
    }
    const spanKm = viewWidthWU * KM_PER_WU;
    let best = defaultTier;
    let bestErr = Number.POSITIVE_INFINITY;
    for (const tier of tiers) {
      const err = Math.abs(tier.km - spanKm);
      if (err < bestErr) {
        best = tier;
        bestErr = err;
      }
    }
    return best;
  };

  return { pick };
})();

export const ScaleTiers = {
  pick: ScaleTiersInternal.pick,
};
