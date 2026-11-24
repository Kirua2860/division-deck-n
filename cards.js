// Raretés et probabilités de tirage.
// rarity : common | rare | epic | legendary | mythic
const RARITIES = {
  common:    { label: "Commune",    weight: 65 },
  rare:      { label: "Rare",       weight: 22 },
  epic:      { label: "Épique",     weight: 10 },
  legendary: { label: "Légendaire", weight: 3 },
  mythic:    { label: "Mythique",   weight: 1 },
};

// Le site ne crée aucune carte : tout le catalogue est créé par les admins (espace admin).
const DEFAULT_CARDS = [];

module.exports = { DEFAULT_CARDS, RARITIES };
