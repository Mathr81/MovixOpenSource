const VAVOO_GROUPS = [
  "France", "France Sport", "United Kingdom", "Germany", "Italy", "Spain",
  "Portugal", "Netherlands", "Poland", "Romania", "Bulgaria", "Croatia",
  "Albania", "Balkans", "Turkey", "Arabia", "Russia",
];

function vavooGroupSlug(group) {
  return group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function buildVavooCatalogs(groups = VAVOO_GROUPS) {
  return groups.map((group) => ({
    type: "tv",
    id: `vavoo_${vavooGroupSlug(group)}`,
    name: group,
    _free: true,
  }));
}

module.exports = {
  VAVOO_GROUPS,
  vavooGroupSlug,
  buildVavooCatalogs,
};
