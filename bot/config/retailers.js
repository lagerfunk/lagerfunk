// Retailers the monitor knows (ids match monitor/src/adapters). Plain JS so it imports in Node and Workers.
//
// program:
//   "amazon"  adds ?tag=<AMAZON_TAG>. Prices hidden unless AMAZON_PRICE_ALLOWED=on (Amazon allows prices only via its API).
//             publicOnly: Amazon links may only earn in PUBLIC places, so a private channel gets a plain link.
//   "awin"    https://www.awin1.com/cread.php?awinmid=MID&awinaffid=AFFID&ued=ENCODED_URL
//             MID per shop comes from env AWIN_MIDS, e.g. "otto=1234,cyberport=5678". AFFID from AWIN_AFFILIATE_ID.
//             No MID for a shop = plain link, no "Anzeige".
//   "none"    plain link.
// listPriceIsUvp: fallback only. The monitor sends alert.listPriceType ("uvp") per watch item, which wins.
// Unknown shops (Black Week, generic adapter) arrive with their host as retailer id and get a plain link.

export default {
  amazon: { name: 'Amazon', program: 'amazon', publicOnly: true, domains: ['amazon.de'], aliases: ['amazon.de'] },
  mediamarkt: { name: 'MediaMarkt', program: 'awin', domains: ['mediamarkt.de'] },
  saturn: { name: 'Saturn', program: 'awin', domains: ['saturn.de'] },
  otto: { name: 'OTTO', program: 'awin', domains: ['otto.de'] },
  mueller: { name: 'Müller', program: 'awin', domains: ['mueller.de'] },
  notebooksbilliger: { name: 'notebooksbilliger', program: 'awin', domains: ['notebooksbilliger.de'], aliases: ['nbb'] },
  alternate: { name: 'ALTERNATE', program: 'awin', domains: ['alternate.de'] },
  // Galaxus is a Tradedoubler program (302027), not Awin. Its tracking links come from the Tradedoubler product feed
  // (monitor/src/feeds), so the bot passes them through, labels them "Anzeige" and never wraps them in an Awin link.
  galaxus: { name: 'Galaxus', program: 'none', domains: ['galaxus.de'] },
  proshop: { name: 'Proshop', program: 'awin', domains: ['proshop.de'] },
  computeruniverse: { name: 'computeruniverse', program: 'awin', domains: ['computeruniverse.net'] },
  caseking: { name: 'Caseking', program: 'awin', domains: ['caseking.de'] },
  euronics: { name: 'EURONICS', program: 'awin', domains: ['euronics.de'] },
  expert: { name: 'expert', program: 'awin', domains: ['expert.de'] },
  cyberport: { name: 'Cyberport', program: 'awin', domains: ['cyberport.de'] },
  smyths: { name: 'Smyths Toys', program: 'awin', domains: ['smythstoys.com'] },
  psdirect: { name: 'PlayStation Direct', program: 'none', domains: ['direct.playstation.com'] },
  nvidia: { name: 'NVIDIA Store', program: 'none', domains: ['nvidia.com'] },
};
