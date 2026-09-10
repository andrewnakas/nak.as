#!/usr/bin/env node
// Regenerate the downloadable map files for /land/ from the page's own payload.
//
// land/index.html carries the single source of truth: the photo GPS points, the
// reconstructed boundary and the Brown Brook geometry. Rather than keep a second
// copy of that data, this reads the payload back out of the page and writes the
// exchange formats CalTopo, Gaia, Garmin and Google Earth can import.
//
//   node tools/build-land-exports.mjs
//
// Photo points are [lon, lat, name, hh:mm:ss, elevation_ft] — the EXIF GPS the
// GoPro wrote on 11 August 2019. Times are the camera's local clock (EDT).

import { readFileSync, writeFileSync } from 'node:fs';

const HTML = 'land/index.html';
const SITE = 'https://nak.as/land';
const DATE = '2019-08-11';            // every photo was taken this day
const TZ = '-04:00';                  // camera clock, Eagle Lake ME (EDT)

const html = readFileSync(HTML, 'utf8');
const m = html.match(/<script id="payload" type="application\/json">([\s\S]*?)<\/script>/);
if (!m) throw new Error(`no payload block in ${HTML}`);
const D = JSON.parse(m[1]);

const FT = 0.3048;
const round = (n, d) => Number(n.toFixed(d));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Degrees-minutes-seconds, the form a handheld GPS and most deeds speak.
function dms(v, axis) {
  const hemi = axis === 'lat' ? (v < 0 ? 'S' : 'N') : (v < 0 ? 'W' : 'E');
  const a = Math.abs(v), d = Math.floor(a), mm = Math.floor((a - d) * 60);
  const ss = ((a - d) * 60 - mm) * 60;
  // Prime/double-prime rather than ' and " so the value needs no CSV quoting.
  return `${d}°${String(mm).padStart(2, '0')}\u2032${ss.toFixed(2).padStart(5, '0')}\u2033${hemi}`;
}

const photos = D.photos.map(([lon, lat, name, time, ft], i) => ({
  i: i + 1, lon, lat, name, time, ft,
  m: round(ft * FT, 1),
  iso: `${DATE}T${time}${TZ}`,
  url: `${SITE}/photos/${name}.jpg`,
}));

/* ---- CSV: the raw GPS metadata, one row per photo ---- */
const csv = [
  'seq,photo,latitude,longitude,elevation_ft,elevation_m,time_local,timestamp,lat_dms,lon_dms,url',
  ...photos.map(p => [
    p.i, p.name, p.lat, p.lon, p.ft, p.m, p.time, p.iso,
    dms(p.lat, 'lat'), dms(p.lon, 'lon'), p.url,
  ].join(',')),
].join('\n') + '\n';
writeFileSync('land/lot175-photos.csv', csv);

/* ---- GPX: waypoints + the walked track. Garmin, Gaia and CalTopo all take it ---- */
const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="nak.as/land" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>Original Lot 175 — Eagle Lake, Maine</name>
    <desc>38 GPS-tagged photos walked on 11 August 2019, plus the reconstructed lot boundary. Boundary is computed from deed acreage, not surveyed.</desc>
    <link href="${SITE}/"><text>nak.as/land</text></link>
    <time>${DATE}T00:00:00Z</time>
  </metadata>
${photos.map(p => `  <wpt lat="${p.lat}" lon="${p.lon}">
    <ele>${p.m}</ele>
    <time>${p.iso}</time>
    <name>${p.name}</name>
    <desc>Photo ${p.i} of 38 · ${p.time} · ${p.ft} ft · ${esc(dms(p.lat, 'lat'))} ${esc(dms(p.lon, 'lon'))}</desc>
    <link href="${p.url}"><text>${p.name}.jpg</text></link>
    <sym>Camera</sym>
    <type>Photo</type>
  </wpt>`).join('\n')}
  <trk>
    <name>Walked track — 11 Aug 2019</name>
    <desc>Straight-line path through the photo positions, in shutter order.</desc>
    <trkseg>
${photos.map(p => `      <trkpt lat="${p.lat}" lon="${p.lon}"><ele>${p.m}</ele><time>${p.iso}</time></trkpt>`).join('\n')}
    </trkseg>
  </trk>
  <trk>
    <name>Lot 175 boundary (reconstructed — not a survey)</name>
    <trkseg>
${D.poly.map(([lon, lat]) => `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('\n')}
    </trkseg>
  </trk>
</gpx>
`;
writeFileSync('land/lot175.gpx', gpx);

/* ---- GeoJSON: boundary, brook and track keep their real geometry types ---- */
const feature = (geometry, properties) => ({ type: 'Feature', properties, geometry });
const geojson = {
  type: 'FeatureCollection',
  properties: { name: 'Original Lot 175 — Eagle Lake, Maine', source: `${SITE}/` },
  features: [
    feature({ type: 'Polygon', coordinates: [D.poly] }, {
      title: 'Lot 175 boundary (reconstructed)',
      description: 'Computed from deed acreage — 660 ft wide by ~2,224 ft deep. Not a survey.',
      stroke: '#b3372c', 'stroke-width': 2, 'stroke-opacity': 1,
      fill: '#b3372c', 'fill-opacity': 0.12, pattern: 'solid',
    }),
    ...D.brook.map((seg, i) => feature({ type: 'LineString', coordinates: seg }, {
      title: `Brown Brook${D.brook.length > 1 ? ` (${i + 1})` : ''}`,
      description: 'USGS National Hydrography Dataset — the deed calls the brook as the north line.',
      stroke: '#3d6f96', 'stroke-width': 2,
    })),
    feature({ type: 'LineString', coordinates: photos.map(p => [p.lon, p.lat]) }, {
      title: 'Walked track — 11 Aug 2019',
      stroke: '#2f6b46', 'stroke-width': 2,
    }),
    feature({ type: 'Point', coordinates: D.pin }, {
      title: 'Map pin', 'marker-color': '#1c1b18', 'marker-symbol': 'point',
    }),
    ...photos.map(p => feature({ type: 'Point', coordinates: [p.lon, p.lat] }, {
      title: p.name,
      description: `Photo ${p.i} of 38 · ${p.time} · ${p.ft} ft (${p.m} m)\n${dms(p.lat, 'lat')} ${dms(p.lon, 'lon')}\n${p.url}`,
      time: p.iso, elevation_ft: p.ft, photo: p.url,
      'marker-color': '#2f6b46', 'marker-symbol': 'camera', 'marker-size': 'small',
    })),
  ],
};
writeFileSync('land/lot175.geojson', JSON.stringify(geojson, null, 1) + '\n');

/* ---- KML: Google Earth shows the photo itself in the balloon ---- */
const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Original Lot 175 — Eagle Lake, Maine</name>
  <description><![CDATA[38 GPS-tagged photos from 11 August 2019. Boundary reconstructed from deed acreage — not a survey. <a href="${SITE}/">nak.as/land</a>]]></description>
  <Style id="photo">
    <IconStyle><scale>0.9</scale>
      <Icon><href>https://maps.google.com/mapfiles/kml/shapes/camera.png</href></Icon>
    </IconStyle>
  </Style>
  <Style id="bound">
    <LineStyle><color>ff2c37b3</color><width>3</width></LineStyle>
    <PolyStyle><color>202c37b3</color></PolyStyle>
  </Style>
  <Style id="track"><LineStyle><color>ff466b2f</color><width>3</width></LineStyle></Style>
  <Style id="water"><LineStyle><color>ff966f3d</color><width>3</width></LineStyle></Style>
  <Placemark><name>Lot 175 boundary (reconstructed)</name><styleUrl>#bound</styleUrl>
    <Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>
      ${D.poly.map(([lon, lat]) => `${lon},${lat},0`).join(' ')}
    </coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
${D.brook.map((seg, i) => `  <Placemark><name>Brown Brook ${i + 1}</name><styleUrl>#water</styleUrl>
    <LineString><tessellate>1</tessellate><coordinates>${seg.map(([lon, lat]) => `${lon},${lat},0`).join(' ')}</coordinates></LineString>
  </Placemark>`).join('\n')}
  <Placemark><name>Walked track — 11 Aug 2019</name><styleUrl>#track</styleUrl>
    <LineString><tessellate>1</tessellate><coordinates>${photos.map(p => `${p.lon},${p.lat},0`).join(' ')}</coordinates></LineString>
  </Placemark>
  <Folder><name>Photos</name>
${photos.map(p => `    <Placemark>
      <name>${p.name}</name>
      <styleUrl>#photo</styleUrl>
      <TimeStamp><when>${p.iso}</when></TimeStamp>
      <description><![CDATA[<img src="${p.url}" width="420"><br>Photo ${p.i} of 38 · ${p.time} · ${p.ft} ft<br>${dms(p.lat, 'lat')} ${dms(p.lon, 'lon')}]]></description>
      <Point><coordinates>${p.lon},${p.lat},${p.m}</coordinates></Point>
    </Placemark>`).join('\n')}
  </Folder>
</Document>
</kml>
`;
writeFileSync('land/lot175.kml', kml);

console.log(`${photos.length} photos -> land/lot175-photos.csv, lot175.gpx, lot175.geojson, lot175.kml`);
