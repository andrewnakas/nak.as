// Places people actually name when they say where they heard a boom.
//
// Longest alias wins, so "gallatin gateway" beats "gallatin" and "bridger
// canyon" beats "bridger". Coordinates are approximate town/neighbourhood
// centres — good to about a kilometre, which is the honest precision of
// "somewhere on the north side" anyway.

export const PLACES = [
  // towns and settlements
  { name: 'Bozeman', ll: [45.6796, -111.0386], aliases: ['bozeman', 'boze'] },
  { name: 'Belgrade', ll: [45.7761, -111.1769], aliases: ['belgrade'] },
  { name: 'Four Corners', ll: [45.6597, -111.1830], aliases: ['four corners', '4 corners'] },
  { name: 'Gallatin Gateway', ll: [45.5983, -111.1980], aliases: ['gallatin gateway', 'gateway'] },
  { name: 'Manhattan', ll: [45.8580, -111.3320], aliases: ['manhattan mt', 'manhattan'] },
  { name: 'Three Forks', ll: [45.8930, -111.5522], aliases: ['three forks'] },
  { name: 'Churchill', ll: [45.7530, -111.3130], aliases: ['churchill'] },
  { name: 'Amsterdam', ll: [45.7420, -111.3320], aliases: ['amsterdam'] },
  { name: 'Livingston', ll: [45.6624, -110.5610], aliases: ['livingston'] },
  { name: 'Big Sky', ll: [45.2846, -111.4014], aliases: ['big sky'] },
  { name: 'Willow Creek', ll: [45.8180, -111.6500], aliases: ['willow creek'] },
  { name: 'Logan', ll: [45.8830, -111.4340], aliases: ['logan mt'] },
  { name: 'Norris', ll: [45.5720, -111.6800], aliases: ['norris'] },
  { name: 'Ennis', ll: [45.3491, -111.7327], aliases: ['ennis'] },
  { name: 'Emigrant', ll: [45.3600, -110.7200], aliases: ['emigrant', 'paradise valley'] },

  // Bozeman neighbourhoods and landmarks
  { name: 'Downtown Bozeman', ll: [45.6796, -111.0386], aliases: ['downtown', 'main street', 'main st'] },
  { name: 'MSU campus', ll: [45.6672, -111.0492], aliases: ['msu', 'campus', 'montana state'] },
  { name: 'Kagy area', ll: [45.6597, -111.0500], aliases: ['kagy'] },
  { name: 'Sourdough', ll: [45.6450, -111.0400], aliases: ['sourdough'] },
  { name: 'Valley West', ll: [45.6820, -111.0900], aliases: ['valley west'] },
  { name: 'Story Mill', ll: [45.6980, -111.0180], aliases: ['story mill'] },
  { name: 'Bridger Creek', ll: [45.7050, -111.0000], aliases: ['bridger creek', 'legends'] },
  { name: 'Baxter / North 19th', ll: [45.7010, -111.0550], aliases: ['baxter', 'north 19th', 'n 19th'] },
  { name: 'Oak Street', ll: [45.6960, -111.0450], aliases: ['oak street', 'oak st'] },
  { name: 'Cottonwood', ll: [45.6650, -111.1400], aliases: ['cottonwood'] },
  { name: 'Bozeman Hot Springs', ll: [45.6400, -111.1800], aliases: ['hot springs'] },
  { name: 'Bozeman Yellowstone Airport', ll: [45.7775, -111.1530], aliases: ['the airport', 'bzn airport', 'gallatin field'] },

  // canyons, mountains, the places sound bounces off
  { name: 'Bridger Canyon', ll: [45.7500, -110.9200], aliases: ['bridger canyon'] },
  { name: 'Bridger Bowl', ll: [45.8175, -110.8975], aliases: ['bridger bowl', 'the bowl'] },
  { name: 'Bridgers', ll: [45.7800, -110.9400], aliases: ['bridgers', 'bridger range'] },
  { name: 'Sypes Canyon', ll: [45.7350, -111.0200], aliases: ['sypes'] },
  { name: 'Kelly Canyon', ll: [45.7700, -110.9300], aliases: ['kelly canyon'] },
  { name: 'Bear Canyon', ll: [45.6600, -110.9200], aliases: ['bear canyon'] },
  { name: 'Bozeman Pass', ll: [45.6600, -110.8500], aliases: ['bozeman pass', 'the pass'] },
  { name: 'Hyalite', ll: [45.5100, -110.9800], aliases: ['hyalite'] },
  { name: 'Gallatin Canyon', ll: [45.4500, -111.2500], aliases: ['gallatin canyon'] },
  { name: 'Springhill', ll: [45.8300, -111.1000], aliases: ['springhill', 'spring hill'] },
  { name: 'Gallatin Valley', ll: [45.7000, -111.1200], aliases: ['gallatin valley', 'the valley'] },
];

// Vaguer, but still worth a pin: "south side of town" is real information.
// Offsets are about 3 km from the middle of Bozeman.
export const AREAS = [
  { name: 'north Bozeman', ll: [45.7080, -111.0386], aliases: ['north side', 'north bozeman', 'north of town', 'north end'] },
  { name: 'south Bozeman', ll: [45.6510, -111.0386], aliases: ['south side', 'south bozeman', 'south of town', 'south end'] },
  { name: 'west Bozeman', ll: [45.6796, -111.0870], aliases: ['west side', 'west bozeman', 'west of town', 'west end'] },
  { name: 'east Bozeman', ll: [45.6796, -110.9900], aliases: ['east side', 'east bozeman', 'east of town', 'east end'] },
  { name: 'northwest Bozeman', ll: [45.7000, -111.0730], aliases: ['northwest', 'nw side', 'nw part of town', 'nw bozeman'] },
  { name: 'northeast Bozeman', ll: [45.7000, -111.0040], aliases: ['northeast', 'ne side', 'ne part of town', 'ne bozeman'] },
  { name: 'southwest Bozeman', ll: [45.6590, -111.0730], aliases: ['southwest', 'sw side', 'sw part of town', 'sw bozeman'] },
  { name: 'southeast Bozeman', ll: [45.6590, -111.0040], aliases: ['southeast', 'se side', 'se part of town', 'se bozeman'] },
];


// Bozeman is a grid, and people describe where they were by intersection:
// "Baxter and Davis", "Davis and Oak", "11th and College". Crossing one
// north-south street with one east-west street puts a post within ~500 m,
// which beats any town-level guess.
const NS_STREETS = [                       // longitude of each avenue
  { name: 'Cottonwood', lon: -111.1090, aliases: ['cottonwood rd', 'cottonwood road'] },
  { name: 'Davis', lon: -111.0940, aliases: ['davis', 'davis ln', 'davis lane'] },
  { name: 'Ferguson', lon: -111.0790, aliases: ['ferguson'] },
  { name: 'Fowler', lon: -111.0730, aliases: ['fowler'] },
  { name: '27th', lon: -111.0680, aliases: ['27th', 'n 27th'] },
  { name: '19th', lon: -111.0570, aliases: ['19th', 'n 19th', 'north 19th'] },
  { name: '15th', lon: -111.0530, aliases: ['15th'] },
  { name: '11th', lon: -111.0490, aliases: ['11th'] },
  { name: '7th', lon: -111.0430, aliases: ['7th', 'n 7th', 'north 7th'] },
  { name: 'Willson', lon: -111.0380, aliases: ['willson', 'wilson ave'] },
  { name: 'Tracy', lon: -111.0350, aliases: ['tracy'] },
  { name: 'Black', lon: -111.0330, aliases: ['black ave'] },
  { name: 'Rouse', lon: -111.0300, aliases: ['rouse'] },
  { name: 'Church', lon: -111.0260, aliases: ['church ave'] },
  { name: 'Highland', lon: -111.0170, aliases: ['highland'] },
  { name: 'Haggerty', lon: -111.0080, aliases: ['haggerty'] },
];

const EW_STREETS = [                       // latitude of each cross street
  { name: 'Valley Center', lat: 45.7220, aliases: ['valley center'] },
  { name: 'Baxter', lat: 45.7080, aliases: ['baxter'] },
  { name: 'Griffin', lat: 45.6980, aliases: ['griffin'] },
  { name: 'Oak', lat: 45.6960, aliases: ['oak', 'oak st', 'oak street'] },
  { name: 'Durston', lat: 45.6900, aliases: ['durston'] },
  { name: 'Beall', lat: 45.6860, aliases: ['beall', 'villard'] },
  { name: 'Main', lat: 45.6790, aliases: ['main st', 'main street', 'e main', 'w main'] },
  { name: 'Babcock', lat: 45.6775, aliases: ['babcock'] },
  { name: 'Olive', lat: 45.6760, aliases: ['olive'] },
  { name: 'College', lat: 45.6720, aliases: ['college st', 'college street', 'college'] },
  { name: 'Garfield', lat: 45.6680, aliases: ['garfield'] },
  { name: 'Kagy', lat: 45.6600, aliases: ['kagy'] },
  { name: 'Graf', lat: 45.6510, aliases: ['graf'] },
  { name: 'Stucky', lat: 45.6440, aliases: ['stucky'] },
  { name: 'Huffine', lat: 45.6740, aliases: ['huffine'] },
];

// "It did NOT come from the fairgrounds" must not drop a pin on the
// fairgrounds. Look just behind each hit for a negation before accepting it.
// The window is deliberately tight: "not come from the fairgrounds" negates
// the fairgrounds, while "not near Baxter, more like Four Corners" must still
// find Four Corners.
const NEGATION = /\b(not|no|nowhere|nothing|never|isn t|wasn t|didn t|doesn t|don t|far from|away from|other than|besides|except)\b[^.!?]{0,16}$/;

function hitAt(hay, alias) {
  let from = 0;
  for (;;) {
    const i = hay.indexOf(` ${alias} `, from);
    if (i === -1) return -1;
    if (!NEGATION.test(hay.slice(Math.max(0, i - 40), i + 1))) return i;
    from = i + 1;
  }
}

function streetHit(list, hay) {
  let best = null;
  for (const st of list) {
    for (const a of st.aliases) {
      if (hitAt(hay, a) !== -1 && (!best || a.length > best.alias.length)) {
        best = { ...st, alias: a };
      }
    }
  }
  return best;
}

// One north-south street plus one east-west street is a corner.
function findIntersection(hay) {
  const ns = streetHit(NS_STREETS, hay);
  const ew = streetHit(EW_STREETS, hay);
  if (!ns || !ew) return null;
  return {
    name: `${ew.name} & ${ns.name}`,
    lat: ew.lat,
    lon: ns.lon,
    conf: 'stated',
  };
}

// Build one alias table, longest first so specific names win over loose ones.
const INDEX = [
  ...PLACES.map((p) => ({ ...p, conf: 'stated' })),
  ...AREAS.map((p) => ({ ...p, conf: 'area' })),
]
  .flatMap((p) => p.aliases.map((a) => ({ alias: a, name: p.name, ll: p.ll, conf: p.conf })))
  .sort((a, b) => b.alias.length - a.alias.length);

// Find the most specific place named in a chunk of text. "Bozeman" alone is
// too coarse to pin (the whole map is Bozeman), so it only counts when nothing
// finer matched, and then only as an area.
export function findPlace(text) {
  if (!text) return null;
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

  // A named corner is the most precise thing anyone gives us; take it first.
  const corner = findIntersection(hay);
  if (corner) return corner;

  let generic = null;
  for (const entry of INDEX) {
    if (hitAt(hay, entry.alias) === -1) continue;
    if (entry.name === 'Bozeman' || entry.name === 'Gallatin Valley') {
      generic = generic || { ...entry, conf: 'area' };
      continue;
    }
    return { name: entry.name, lat: entry.ll[0], lon: entry.ll[1], conf: entry.conf };
  }
  return generic ? { name: generic.name, lat: generic.ll[0], lon: generic.ll[1], conf: 'area' } : null;
}
