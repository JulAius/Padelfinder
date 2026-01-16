/**
 * Padel Finder – Frontend Application
 * Aggregates and displays French padel tournaments from TenUp
 */

// ═══════════════════════════════════════════════════════════════════════════
// DOM ELEMENTS
// ═══════════════════════════════════════════════════════════════════════════

const searchInput = document.getElementById("search");
const levelSelect = document.getElementById("level");
const eTypeSelect = document.getElementById("etype");
const maxDistanceInput = document.getElementById("max-distance");
const startDateInput = document.getElementById("start-date");
const endDateInput = document.getElementById("end-date");
const locNameInput = document.getElementById("loc-name");
const locLatInput = document.getElementById("loc-lat");
const locLngInput = document.getElementById("loc-lng");
const radiusInput = document.getElementById("radius");
const sortSelect = document.getElementById("sort");
const resetBtn = document.getElementById("reset");
const summaryEl = document.getElementById("summary-text");
const resultsCountEl = document.getElementById("results-count");
const resultsEl = document.getElementById("results");
const cardTpl = document.getElementById("card-template");
const searchRemoteBtn = document.getElementById("search-remote");
const resultsSection = document.querySelector(".results-section");
const viewListBtn = document.getElementById("view-list");
const viewMapBtn = document.getElementById("view-map");
const mapContainer = document.getElementById("map-container");
const mapLoader = document.getElementById("map-loader");

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:8001"
  : "";

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

let rawItems = [];
let meta = {};
let map = null;
let searchCircle = null;
let markers = [];
let currentView = "list"; // "list" or "map"

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

const parseDate = (s) => {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d;
};

const parseDistanceKm = (val) => {
  if (!val) return Infinity;
  const num = parseFloat(String(val).replace(" km", "").replace(",", "."));
  return isNaN(num) ? Infinity : num;
};

const toRad = (d) => (d * Math.PI) / 180;

const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const safeText = (val) => (val == null ? "" : String(val).trim());

const formatNature = (nature) => {
  if (!nature) return "";
  if (typeof nature === "string") return nature.trim();
  return (nature.code || nature.libelle || "").trim();
};

const formatDateRange = (debut, fin) => {
  const startStr = debut?.date || debut;
  const endStr = fin?.date || fin;
  const start = parseDate(startStr);
  const end = parseDate(endStr);

  const opts = { day: "numeric", month: "short" };
  const optsYear = { day: "numeric", month: "short", year: "numeric" };

  if (start && end) {
    const sameYear = start.getFullYear() === end.getFullYear();
    const sameDay = start.toDateString() === end.toDateString();

    if (sameDay) {
      return start.toLocaleDateString("fr-FR", optsYear);
    }

    if (sameYear) {
      return `${start.toLocaleDateString("fr-FR", opts)} → ${end.toLocaleDateString("fr-FR", optsYear)}`;
    }

    return `${start.toLocaleDateString("fr-FR", optsYear)} → ${end.toLocaleDateString("fr-FR", optsYear)}`;
  }

  if (start) return start.toLocaleDateString("fr-FR", optsYear);
  return "";
};

// ═══════════════════════════════════════════════════════════════════════════
// GEOCODING
// ═══════════════════════════════════════════════════════════════════════════

async function geocodeCity(name) {
  if (!name) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=fr&q=${encodeURIComponent(name)}`;

  try {
    const resp = await fetch(url, {
      headers: { "Accept-Language": "fr", "User-Agent": "PadelFinder/1.0" },
    });
    if (!resp.ok) return null;
    const arr = await resp.json();
    if (!arr?.length) return null;

    const best = arr[0];
    return {
      lat: parseFloat(best.lat),
      lng: parseFloat(best.lon),
      name: best.display_name || name,
    };
  } catch (e) {
    console.warn("Geocode error:", e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAP FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

// Initialize Leaflet map with quick search zones - FRANCE ONLY
function initMap() {
  if (map) return; // Already initialized

  // France boundaries (approximate)
  const franceBounds = [
    [41.0, -5.5],  // Southwest corner (near Spain)
    [51.5, 10.0]   // Northeast corner (near Germany)
  ];

  map = L.map('map', {
    center: [46.603354, 1.888334], // Center of France
    zoom: 6,
    minZoom: 5,  // Prevent zooming out too far
    maxZoom: 18,
    zoomControl: true,
    scrollWheelZoom: true,
    maxBounds: franceBounds,  // Restrict to France
    maxBoundsViscosity: 0.8  // Smooth bounce at edges
  });

  // Add CartoDB Dark Matter tiles for modern dark theme
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  // Add quick search zones for French departments
  addQuickSearchZones();

  // Click on map to set search location
  map.on('click', (e) => {
    updateSearchLocation(e.latlng.lat, e.latlng.lng);
  });
}

// Add quick search zones for ALL 96 French departments
function addQuickSearchZones() {
  const allDepartments = [
    // 01-19
    { num: '01', name: 'Ain', lat: 46.0659, lng: 5.3500, radius: 30 },
    { num: '02', name: 'Aisne', lat: 49.5647, lng: 3.6234, radius: 35 },
    { num: '03', name: 'Allier', lat: 46.5667, lng: 3.3333, radius: 35 },
    { num: '04', name: 'Alpes-de-Haute-Provence', lat: 44.0942, lng: 6.2356, radius: 35 },
    { num: '05', name: 'Hautes-Alpes', lat: 44.6606, lng: 6.0806, radius: 35 },
    { num: '06', name: 'Alpes-Maritimes', lat: 43.9403, lng: 7.2083, radius: 25 },
    { num: '07', name: 'Ardèche', lat: 44.7364, lng: 4.6006, radius: 35 },
    { num: '08', name: 'Ardennes', lat: 49.7619, lng: 4.7211, radius: 30 },
    { num: '09', name: 'Ariège', lat: 42.9869, lng: 1.6075, radius: 30 },
    { num: '10', name: 'Aube', lat: 48.2972, lng: 4.0767, radius: 30 },
    { num: '11', name: 'Aude', lat: 43.2130, lng: 2.3522, radius: 35 },
    { num: '12', name: 'Aveyron', lat: 44.3506, lng: 2.5750, radius: 40 },
    { num: '13', name: 'Bouches-du-Rhône', lat: 43.5297, lng: 5.4474, radius: 30 },
    { num: '14', name: 'Calvados', lat: 49.1829, lng: -0.3707, radius: 30 },
    { num: '15', name: 'Cantal', lat: 45.0356, lng: 2.7083, radius: 35 },
    { num: '16', name: 'Charente', lat: 45.6500, lng: 0.1500, radius: 30 },
    { num: '17', name: 'Charente-Maritime', lat: 45.7485, lng: -0.6328, radius: 35 },
    { num: '18', name: 'Cher', lat: 47.0833, lng: 2.3967, radius: 30 },
    { num: '19', name: 'Corrèze', lat: 45.3500, lng: 1.7667, radius: 30 },
    { num: '2A', name: 'Corse-du-Sud', lat: 41.9267, lng: 8.7369, radius: 25 },
    { num: '2B', name: 'Haute-Corse', lat: 42.4978, lng: 9.1789, radius: 30 },
    { num: '21', name: 'Côte-d\'Or', lat: 47.3220, lng: 4.8320, radius: 35 },
    { num: '22', name: 'Côtes-d\'Armor', lat: 48.5139, lng: -2.7608, radius: 30 },
    { num: '23', name: 'Creuse', lat: 46.1667, lng: 1.8667, radius: 30 },
    { num: '24', name: 'Dordogne', lat: 45.1833, lng: 0.7167, radius: 35 },
    { num: '25', name: 'Doubs', lat: 47.2375, lng: 6.0244, radius: 30 },
    { num: '26', name: 'Drôme', lat: 44.7333, lng: 5.0167, radius: 35 },
    { num: '27', name: 'Eure', lat: 49.0242, lng: 1.1508, radius: 30 },
    { num: '28', name: 'Eure-et-Loir', lat: 48.4469, lng: 1.4892, radius: 30 },
    { num: '29', name: 'Finistère', lat: 48.3904, lng: -4.0861, radius: 35 },
    { num: '30', name: 'Gard', lat: 43.9608, lng: 4.3603, radius: 30 },
    { num: '31', name: 'Haute-Garonne', lat: 43.6047, lng: 1.4442, radius: 30 },
    { num: '32', name: 'Gers', lat: 43.6456, lng: 0.5861, radius: 30 },
    { num: '33', name: 'Gironde', lat: 44.8378, lng: -0.5792, radius: 35 },
    { num: '34', name: 'Hérault', lat: 43.6108, lng: 3.8767, radius: 30 },
    { num: '35', name: 'Ille-et-Vilaine', lat: 48.1173, lng: -1.6778, radius: 30 },
    { num: '36', name: 'Indre', lat: 46.8103, lng: 1.6919, radius: 30 },
    { num: '37', name: 'Indre-et-Loire', lat: 47.3936, lng: 0.6892, radius: 30 },
    { num: '38', name: 'Isère', lat: 45.1885, lng: 5.7245, radius: 35 },
    { num: '39', name: 'Jura', lat: 46.6719, lng: 5.5550, radius: 30 },
    { num: '40', name: 'Landes', lat: 43.8942, lng: -0.4992, radius: 35 },
    { num: '41', name: 'Loir-et-Cher', lat: 47.5850, lng: 1.3353, radius: 30 },
    { num: '42', name: 'Loire', lat: 45.4397, lng: 4.3872, radius: 25 },
    { num: '43', name: 'Haute-Loire', lat: 45.0433, lng: 3.8850, radius: 30 },
    { num: '44', name: 'Loire-Atlantique', lat: 47.2184, lng: -1.5536, radius: 30 },
    { num: '45', name: 'Loiret', lat: 47.9027, lng: 2.3972, radius: 30 },
    { num: '46', name: 'Lot', lat: 44.4472, lng: 1.4406, radius: 30 },
    { num: '47', name: 'Lot-et-Garonne', lat: 44.2025, lng: 0.6156, radius: 30 },
    { num: '48', name: 'Lozère', lat: 44.5183, lng: 3.5006, radius: 30 },
    { num: '49', name: 'Maine-et-Loire', lat: 47.4739, lng: -0.5522, radius: 30 },
    { num: '50', name: 'Manche', lat: 49.1167, lng: -1.0833, radius: 35 },
    { num: '51', name: 'Marne', lat: 48.9569, lng: 4.3656, radius: 30 },
    { num: '52', name: 'Haute-Marne', lat: 48.1128, lng: 5.1361, radius: 30 },
    { num: '53', name: 'Mayenne', lat: 48.3064, lng: -0.6167, radius: 25 },
    { num: '54', name: 'Meurthe-et-Moselle', lat: 48.6936, lng: 6.1846, radius: 30 },
    { num: '55', name: 'Meuse', lat: 49.0097, lng: 5.3825, radius: 30 },
    { num: '56', name: 'Morbihan', lat: 47.7467, lng: -2.7633, radius: 30 },
    { num: '57', name: 'Moselle', lat: 49.1197, lng: 6.1778, radius: 35 },
    { num: '58', name: 'Nièvre', lat: 47.0000, lng: 3.5333, radius: 30 },
    { num: '59', name: 'Nord', lat: 50.6292, lng: 3.0573, radius: 30 },
    { num: '60', name: 'Oise', lat: 49.4175, lng: 2.8258, radius: 30 },
    { num: '61', name: 'Orne', lat: 48.4333, lng: 0.0917, radius: 30 },
    { num: '62', name: 'Pas-de-Calais', lat: 50.5111, lng: 2.6356, radius: 35 },
    { num: '63', name: 'Puy-de-Dôme', lat: 45.7722, lng: 3.0819, radius: 30 },
    { num: '64', name: 'Pyrénées-Atlantiques', lat: 43.2951, lng: -0.3708, radius: 35 },
    { num: '65', name: 'Hautes-Pyrénées', lat: 43.2328, lng: 0.0781, radius: 30 },
    { num: '66', name: 'Pyrénées-Orientales', lat: 42.6986, lng: 2.8956, radius: 30 },
    { num: '67', name: 'Bas-Rhin', lat: 48.5734, lng: 7.7521, radius: 25 },
    { num: '68', name: 'Haut-Rhin', lat: 47.7497, lng: 7.3389, radius: 25 },
    { num: '69', name: 'Rhône', lat: 45.7640, lng: 4.8357, radius: 20 },
    { num: '70', name: 'Haute-Saône', lat: 47.6167, lng: 6.1500, radius: 30 },
    { num: '71', name: 'Saône-et-Loire', lat: 46.6514, lng: 4.3917, radius: 35 },
    { num: '72', name: 'Sarthe', lat: 48.0077, lng: 0.1996, radius: 30 },
    { num: '73', name: 'Savoie', lat: 45.5647, lng: 6.3972, radius: 30 },
    { num: '74', name: 'Haute-Savoie', lat: 46.0658, lng: 6.3564, radius: 30 },
    { num: '75', name: 'Paris', lat: 48.8566, lng: 2.3522, radius: 15 },
    { num: '76', name: 'Seine-Maritime', lat: 49.6436, lng: 1.0819, radius: 30 },
    { num: '77', name: 'Seine-et-Marne', lat: 48.6117, lng: 2.9983, radius: 35 },
    { num: '78', name: 'Yvelines', lat: 48.8049, lng: 1.9675, radius: 25 },
    { num: '79', name: 'Deux-Sèvres', lat: 46.5333, lng: -0.3667, radius: 30 },
    { num: '80', name: 'Somme', lat: 49.8942, lng: 2.3017, radius: 30 },
    { num: '81', name: 'Tarn', lat: 43.9289, lng: 2.1481, radius: 30 },
    { num: '82', name: 'Tarn-et-Garonne', lat: 44.0178, lng: 1.3547, radius: 25 },
    { num: '83', name: 'Var', lat: 43.4245, lng: 6.2371, radius: 35 },
    { num: '84', name: 'Vaucluse', lat: 44.0533, lng: 5.0497, radius: 25 },
    { num: '85', name: 'Vendée', lat: 46.6703, lng: -1.4267, radius: 30 },
    { num: '86', name: 'Vienne', lat: 46.5803, lng: 0.3403, radius: 30 },
    { num: '87', name: 'Haute-Vienne', lat: 45.8336, lng: 1.2611, radius: 25 },
    { num: '88', name: 'Vosges', lat: 48.1717, lng: 6.4514, radius: 35 },
    { num: '89', name: 'Yonne', lat: 47.7981, lng: 3.5689, radius: 30 },
    { num: '90', name: 'Territoire de Belfort', lat: 47.6381, lng: 6.8628, radius: 15 },
    { num: '91', name: 'Essonne', lat: 48.5297, lng: 2.2372, radius: 20 },
    { num: '92', name: 'Hauts-de-Seine', lat: 48.8499, lng: 2.2370, radius: 15 },
    { num: '93', name: 'Seine-Saint-Denis', lat: 48.9092, lng: 2.4844, radius: 15 },
    { num: '94', name: 'Val-de-Marne', lat: 48.7919, lng: 2.4872, radius: 15 },
    { num: '95', name: 'Val-d\'Oise', lat: 49.0506, lng: 2.1081, radius: 20 }
  ];

  allDepartments.forEach(dept => {
    dept.radius = 100; // Force default radius to 100

    // Create minimalist dot marker
    const icon = L.divIcon({
      className: 'dept-icon',
      html: `<div class="dept-dot"><span>${dept.num}</span></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    const marker = L.marker([dept.lat, dept.lng], {
      icon,
      title: dept.name // Tooltip browser natif
    }).addTo(map);

    // Bind tooltip with department name - clean and simple
    marker.bindTooltip(`<strong>${dept.num}</strong> - ${dept.name}`, {
      direction: 'top',
      offset: [0, -10],
      className: 'dept-tooltip-modern'
    });

    // Quick search on click
    marker.on('click', () => {
      quickSearchDept(dept.name, dept.lat, dept.lng, 100);
    });
  });
}


// Quick search function for departments
window.quickSearchDept = async function (deptName, lat, lng, radius) {
  locNameInput.value = deptName;
  locLatInput.value = lat.toFixed(4);
  locLngInput.value = lng.toFixed(4);
  radiusInput.value = radius;

  // Trigger search
  searchRemoteBtn.click();
};


// Center map on search area (without showing a visual circle)
function updateSearchCircle(lat, lng, radius) {
  if (!map) return;

  // We create a temporary invisible circle to calculate the bounds for the zoom
  const tempCircle = L.circle([lat, lng], { radius: radius * 1000 });

  // Smoothly fit the map to the search area
  map.fitBounds(tempCircle.getBounds(), {
    padding: [20, 20],
    animate: true,
    duration: 1
  });
}

// Update search location from map click
function updateSearchLocation(lat, lng) {
  locLatInput.value = lat.toFixed(4);
  locLngInput.value = lng.toFixed(4);

  const radius = radiusInput.value || 100;
  updateSearchCircle(lat, lng, radius);
}

// Level colors mapping
const levelColors = {
  'P25': '#22c55e',
  'P100': '#3b82f6',
  'P250': '#8b5cf6',
  'P500': '#f59e0b',
  'P1000': '#ef4444',
  'P1500': '#ec4899',
  'P2000': '#dc2626'
};

// Display tournaments on map
function displayTournamentsOnMap(tournaments, forceCenter = null) {
  if (!map) initMap();

  // Clear existing markers
  markers.forEach(marker => map.removeLayer(marker));
  markers = [];

  const group = L.featureGroup();

  // Add marker for each tournament
  tournaments.forEach(tournament => {
    const lat = tournament.installation?.lat;
    const lng = tournament.installation?.lng;

    if (!lat || !lng) return;

    // Get level for color
    const level = formatNature(tournament.epreuves?.[0]?.typeEpreuve) || '';
    const color = levelColors[level] || '#14b8a6';

    // Create custom icon
    const icon = L.divIcon({
      className: 'tennis-marker-container',
      html: `
        <div class="tennis-ball-marker" style="--ball-color: ${color};">
          <div class="seam"></div>
        </div>
      `,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -10]
    });

    // Create marker
    const marker = L.marker([lat, lng], { icon }).addTo(map);

    // Create popup content
    const popupContent = createPopupContent(tournament);
    marker.bindPopup(popupContent);

    markers.push(marker);
    marker.addTo(group);
  });

  // Smart Zoom logic
  if (forceCenter) {
    // If we have a specific search point, go there
    // Using zoom 9 for 100km radius (more context)
    map.flyTo([forceCenter.lat, forceCenter.lng], 9, {
      duration: 1.5,
      easeLinearity: 0.25
    });
  } else if (markers.length > 0) {
    // Otherwise, fit all markers with some padding
    map.fitBounds(group.getBounds(), {
      padding: [50, 50],
      maxZoom: 12,
      animate: true,
      duration: 1.5
    });
  }
}

// Create popup HTML for tournament
function createPopupContent(tournament) {
  const title = tournament.libelle || 'Tournoi';
  const clubName = tournament.nomClub || "";
  const dateStr = formatDateRange(tournament.dateDebut, tournament.dateFin);

  const adresse = [tournament.installation?.adresse1, tournament.installation?.adresse2].filter(Boolean).join(", ");
  const ville = [tournament.installation?.codePostal, tournament.installation?.ville].filter(Boolean).join(' ');
  const fullLoc = [adresse, ville].filter(Boolean).join("<br>");
  const fullAddressStr = [adresse, ville].filter(Boolean).join(", ");

  const gMapsUrl = tournament.installation?.lat && tournament.installation?.lng
    ? `https://www.google.com/maps/search/?api=1&query=${tournament.installation.lat},${tournament.installation.lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddressStr)}`;

  const level = formatNature(tournament.epreuves?.[0]?.typeEpreuve) || '';

  // Icons (Lucide-style SVGs)
  const iconCalendar = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;
  const iconMapPin = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
  const iconPhone = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>`;
  const iconMail = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`;
  const iconBuilding = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect><line x1="9" y1="22" x2="9" y2="2"></line><line x1="15" y1="22" x2="15" y2="2"></line><line x1="4" y1="6" x2="9" y2="6"></line><line x1="4" y1="10" x2="9" y2="10"></line><line x1="4" y1="14" x2="9" y2="14"></line><line x1="4" y1="18" x2="9" y2="18"></line><line x1="15" y1="6" x2="20" y2="6"></line><line x1="15" y1="10" x2="20" y2="10"></line><line x1="15" y1="14" x2="20" y2="14"></line><line x1="15" y1="18" x2="20" y2="18"></line></svg>`;

  // Contact info - exhaustive extraction
  const phone = tournament.contact?.telPortable ||
    tournament.contact?.telBureau ||
    tournament.installation?.telephone ||
    tournament.contact?.telephone ||
    tournament.telPortable ||
    tournament.telBureau ||
    tournament.telephone || "";

  const email = tournament.courrielEngagement ||
    tournament.courrielSaisie ||
    tournament.courrielResponsable ||
    tournament.contact?.courriel || "";

  const phoneClean = phone.replace(/\s+/g, "").replace(/\./g, "");

  // Registration link (TenUp)
  const tournamentId = tournament.id || tournament.originalId?.replace("FED_", "");
  const registrationUrl = tournamentId
    ? `https://tenup.fft.fr/tournoi/${tournamentId}`
    : `https://tenup.fft.fr/recherche/tournois?q=${encodeURIComponent(tournament.nomClub || '')}`;

  return `
    <div class="tournament-popup">
      <div class="popup-header">
        <div class="popup-title">${title}</div>
        ${clubName ? `<div class="popup-club">${iconBuilding} ${clubName}</div>` : ''}
      </div>
      
      <div class="popup-content-body">
        <div class="popup-info-section">
          <div class="popup-detail-row">
            <span class="popup-detail-icon">${iconCalendar}</span>
            <span class="popup-detail-text">${dateStr}</span>
          </div>
          <div class="popup-detail-row">
            <span class="popup-detail-icon">${iconMapPin}</span>
            <a href="${gMapsUrl}" target="_blank" class="popup-address-link">
              ${fullLoc}
            </a>
          </div>
        </div>
        
        <div class="popup-action-grid">
          ${phone ? `
            <a href="tel:${phoneClean}" class="popup-action-item" title="Appeler">
              <span class="popup-action-icon">${iconPhone}</span>
              <span class="popup-action-label">${formatPhone(phone)}</span>
            </a>
          ` : ''}
          ${email ? `
            <a href="mailto:${email.trim().toLowerCase()}" class="popup-action-item" title="Envoyer un email">
              <span class="popup-action-icon">${iconMail}</span>
              <span class="popup-action-label">Email</span>
            </a>
          ` : ''}
        </div>
      </div>

      <div class="popup-footer">
        ${level ? `<span class="popup-level-badge">${level}</span>` : ''}
        <a href="${registrationUrl}" target="_blank" class="popup-cta-button">
          S'inscrire sur Ten'Up
        </a>
      </div>
    </div>
  `;
}


// Toggle between map and list view
function setView(view) {
  currentView = view;

  if (view === 'map') {
    // Show map, hide list
    if (mapContainer) mapContainer.style.display = 'block';
    if (resultsEl) resultsEl.style.display = 'none';
    viewMapBtn?.classList.add('active');
    viewListBtn?.classList.remove('active');

    // Initialize and update map
    if (!map) initMap();

    // Update map with current results
    const filtered = getFilteredItems();
    const sorted = sortItems(filtered);
    displayTournamentsOnMap(sorted);

    // If we have search coordinates, show circle
    const lat = locLatInput?.value;
    const lng = locLngInput?.value;
    const radius = radiusInput?.value || 100;
    if (lat && lng) {
      updateSearchCircle(parseFloat(lat), parseFloat(lng), parseFloat(radius));
    }

    // Invalidate size after showing (fixes rendering issues)
    if (map) setTimeout(() => map.invalidateSize(), 100);
  } else {
    // Show list, hide map
    if (mapContainer) mapContainer.style.display = 'none';
    if (resultsEl) resultsEl.style.display = 'grid';
    viewListBtn?.classList.add('active');
    viewMapBtn?.classList.remove('active');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// DATA PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

function dedupeAndSet(items, metaInfo = {}) {
  const seen = new Set();
  rawItems = [];

  for (const it of items) {
    const key = `${it.originalId || it.id || ""}|${it.code || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rawItems.push(it);
  }

  meta = { ...metaInfo, count: rawItems.length };

  // If we have a center in meta, pass it to render
  const center = (metaInfo.params?.lat && metaInfo.params?.lng)
    ? { lat: Number(metaInfo.params.lat), lng: Number(metaInfo.params.lng) }
    : null;

  render(center);
}

// ═══════════════════════════════════════════════════════════════════════════
// FILTERING & SORTING
// ═══════════════════════════════════════════════════════════════════════════

function getFilteredItems() {
  const q = searchInput.value.trim().toLowerCase();
  const level = levelSelect.value;
  const eType = eTypeSelect.value;
  const maxKm = maxDistanceInput.value ? Number(maxDistanceInput.value) : Infinity;
  const radiusKm = radiusInput.value ? Number(radiusInput.value) : Infinity;
  const userLat = locLatInput.value ? Number(locLatInput.value) : null;
  const userLng = locLngInput.value ? Number(locLngInput.value) : null;
  const startFilter = parseDate(startDateInput.value);
  const endFilter = parseDate(endDateInput.value);

  return rawItems.filter((it) => {
    // Text search
    const hay = [it.libelle, it.nomClub, it.installation?.ville, it.installation?.codePostal]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (q && !hay.includes(q)) return false;

    // Level filter
    if (level) {
      const match = (it.epreuves || []).some((e) => formatNature(e.typeEpreuve) === level);
      if (!match) return false;
    }

    // Event type filter
    if (eType) {
      const match = (it.epreuves || []).some((e) => {
        const type = formatNature(e.typeEpreuve);
        const nature = formatNature(e.natureEpreuve);
        return type === eType || nature === eType;
      });
      if (!match) return false;
    }

    // Distance filter
    const fallbackKm = parseDistanceKm(it.distanceEnMetres);
    let km = fallbackKm;
    if (userLat != null && userLng != null && it.installation?.lat && it.installation?.lng) {
      km = haversineKm(userLat, userLng, Number(it.installation.lat), Number(it.installation.lng));
    }
    if (maxKm !== Infinity && km > maxKm) return false;
    if (radiusKm !== Infinity && km > radiusKm) return false;

    // Date range filter
    const startStr = it.dateDebut?.date || it.dateDebut;
    const endStr = it.dateFin?.date || it.dateFin;
    const start = parseDate(startStr);
    const end = parseDate(endStr);
    if (startFilter && start && start < startFilter) return false;
    if (endFilter && end && end > endFilter) return false;

    return true;
  });
}

function sortItems(items) {
  const sortBy = sortSelect.value;

  return items.slice().sort((a, b) => {
    if (sortBy === "distance") {
      return parseDistanceKm(a.distanceEnMetres) - parseDistanceKm(b.distanceEnMetres);
    }
    if (sortBy === "libelle") {
      return (a.libelle || "").localeCompare(b.libelle || "", "fr");
    }
    // Default: date
    const da = parseDate(a.dateDebut?.date || a.dateDebut) || 0;
    const db = parseDate(b.dateDebut?.date || b.dateDebut) || 0;
    return da - db;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════════════════

function render(forceCenter = null) {
  const filtered = getFilteredItems();
  const sorted = sortItems(filtered);

  // Update summary
  const userLat = locLatInput?.value ? Number(locLatInput.value) : null;
  const userLng = locLngInput?.value ? Number(locLngInput.value) : null;

  if (rawItems.length === 0) {
    if (summaryEl) summaryEl.textContent = "Entrez une ville pour commencer";
    if (resultsCountEl) resultsCountEl.textContent = "";
  } else {
    const centerInfo = userLat != null ? ` • Centre: ${locNameInput?.value?.split(",")[0]}` : "";
    if (summaryEl) summaryEl.textContent = `${sorted.length} tournoi${sorted.length > 1 ? "s" : ""} trouvé${sorted.length > 1 ? "s" : ""}${centerInfo}`;
    if (resultsCountEl) resultsCountEl.textContent = `${sorted.length} / ${rawItems.length}`;
  }

  // Render cards
  resultsEl.innerHTML = "";
  if (sorted.length === 0) {
    showEmptyState();
  } else {
    sorted.forEach((it) => resultsEl.appendChild(renderCard(it)));
  }

  // Update map and timeline
  if (sorted.length > 0) {
    if (map) displayTournamentsOnMap(sorted, forceCenter);
    renderTimeline(sorted);
  } else {
    // Clear timeline if no results
    const markers = document.getElementById("timeline-markers");
    if (markers) markers.innerHTML = "";

    // If we have a center but no results, still zoom there
    if (map && forceCenter) {
      map.flyTo([forceCenter.lat, forceCenter.lng], 10);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TIMELINE RENDERING
// ═══════════════════════════════════════════════════════════════════════════

function renderTimeline(tournaments) {
  const container = document.getElementById("timeline-markers");
  const startLabel = document.getElementById("timeline-start-label");
  const endLabel = document.getElementById("timeline-end-label");
  if (!container) return;

  container.innerHTML = "";

  // Group tournaments by date to avoid overlapping dots on same day
  const dailyGroups = {};
  tournaments.forEach(t => {
    const dStr = itDateStr(t.dateDebut);
    if (!dStr) return;
    if (!dailyGroups[dStr]) dailyGroups[dStr] = [];
    dailyGroups[dStr].push(t);
  });

  const dates = Object.keys(dailyGroups).sort();
  if (dates.length === 0) return;

  const minDate = new Date(dates[0]);
  const maxDate = new Date(dates[dates.length - 1]);
  const duration = Math.max(1, maxDate - minDate);

  startLabel.textContent = minDate.toLocaleDateString("fr-FR", { day: '2-digit', month: 'short' });
  endLabel.textContent = maxDate.toLocaleDateString("fr-FR", { day: '2-digit', month: 'short' });

  dates.forEach((dStr, index) => {
    const date = new Date(dStr);
    const count = dailyGroups[dStr].length;
    const pos = ((date - minDate) / duration) * 100;

    const dot = document.createElement("div");
    dot.className = "timeline-dot";

    // Alternate positions: up, down, or center if only one
    if (dates.length > 1) {
      dot.classList.add(index % 2 === 0 ? "up" : "down");
    } else {
      dot.classList.add("center");
    }

    dot.style.left = `${pos}%`;

    // Scale slightly if many tournaments
    const scale = Math.min(1.5, 1 + (count - 1) * 0.1);
    dot.style.transform += ` scale(${scale})`;

    const info = document.createElement("div");
    info.className = "dot-info";
    const displayDate = date.toLocaleDateString("fr-FR", { day: 'numeric', month: 'long' });
    info.innerHTML = `
      <div style="font-weight: 800; color: var(--accent);">${displayDate}</div>
      <div style="font-size: 0.7rem; opacity: 0.8;">${count} tournoi${count > 1 ? 's' : ''}</div>
    `;
    dot.appendChild(info);

    container.appendChild(dot);
  });
}

function itDateStr(d) {
  if (!d) return null;
  const s = d.date || d;
  if (!s || typeof s !== 'string') return null;
  return s.split(' ')[0]; // YYYY-MM-DD
}

function renderCard(it) {
  const node = cardTpl.content.cloneNode(true);
  const card = node.querySelector(".tournament-card");

  // Title
  card.querySelector(".card-title").textContent = it.libelle || "Tournoi sans nom";

  // Badge (level) with dynamic styling
  const badge = card.querySelector(".card-badge");
  const firstLevel = formatNature(it.epreuves?.[0]?.typeEpreuve) || formatNature(it.type);
  badge.textContent = firstLevel || "";

  // Level color mapping - gradient from beginner to pro
  const levelGradients = {
    P25: "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)",   // Green
    P100: "linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)",   // Blue
    P250: "linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)",   // Purple
    P500: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",   // Amber
    P1000: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)",   // Red
    P1500: "linear-gradient(135deg, #ec4899 0%, #db2777 100%)",   // Pink
    P2000: "linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)",   // Deep Red
  };

  const levelShadows = {
    P25: "0 2px 10px rgba(34, 197, 94, 0.5)",
    P100: "0 2px 10px rgba(59, 130, 246, 0.5)",
    P250: "0 2px 10px rgba(139, 92, 246, 0.5)",
    P500: "0 2px 10px rgba(245, 158, 11, 0.5)",
    P1000: "0 2px 10px rgba(239, 68, 68, 0.5)",
    P1500: "0 2px 10px rgba(236, 72, 153, 0.5)",
    P2000: "0 2px 10px rgba(220, 38, 38, 0.5)",
  };

  // Apply badge color directly
  if (firstLevel && levelGradients[firstLevel]) {
    badge.style.background = levelGradients[firstLevel];
    badge.style.boxShadow = levelShadows[firstLevel] || "";
  }

  // Color accent bar at top based on level
  const accent = card.querySelector(".card-accent");
  accent.style.background = levelGradients[firstLevel] || "linear-gradient(90deg, #14b8a6 0%, #0d9488 100%)";

  // Date
  card.querySelector(".date-text").textContent = formatDateRange(it.dateDebut, it.dateFin);

  // Distance
  card.querySelector(".distance-text").textContent = it.distanceEnMetres || "—";

  // Tags inscription & paiement
  const tagInscription = card.querySelector(".tag-inscription");
  const tagPaiement = card.querySelector(".tag-paiement");

  if (it.inscriptionEnLigne === true || it.inscriptionEnLigne === "true") {
    tagInscription.textContent = "Inscription en ligne";
  } else {
    tagInscription.classList.add("tag-closed");
    tagInscription.textContent = "Inscription hors ligne";
  }

  if (it.paiementEnLigne === true || it.paiementEnLigne === "true") {
    tagPaiement.textContent = "Paiement en ligne";
  }

  // Club
  card.querySelector(".club-name").textContent = it.nomClub || "Club non renseigné";

  // Address - Make the whole block clickable
  const adresse = [it.installation?.adresse1, it.installation?.adresse2].filter(Boolean).join(", ");
  const ville = [it.installation?.codePostal, it.installation?.ville].filter(Boolean).join(" ");
  const fullAddress = [adresse, ville].filter(Boolean).join(", ");

  const addressBlock = card.querySelector(".address-block");
  const gMapsUrl = it.installation?.lat && it.installation?.lng
    ? `https://www.google.com/maps/search/?api=1&query=${it.installation.lat},${it.installation.lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`;

  // Registration link (TenUp)
  const tournamentId = it.id || it.originalId?.replace("FED_", "");
  const registrationUrl = tournamentId
    ? `https://tenup.fft.fr/tournoi/${tournamentId}`
    : `https://tenup.fft.fr/recherche/tournois?q=${encodeURIComponent(it.nomClub || '')}`;

  const registerBtn = card.querySelector(".btn-register-card");
  if (registerBtn) {
    registerBtn.href = registrationUrl;
  }

  addressBlock.innerHTML = `
    <a href="${gMapsUrl}" target="_blank" class="clickable-address">
      <span class="address-line">${adresse || ""}</span>
      <span class="city-line">${ville || "Lieu non précisé"}</span>
    </a>
  `;

  // Category
  const category = it.categorieTournoi?.libelle || it.categorieTournoi?.code || "";
  setDetailValue(card, ".category-text", category);

  // Juge-arbitre
  const arbitrePrenom = it.jugeArbitre?.prenom && it.jugeArbitre.prenom !== "null" ? it.jugeArbitre.prenom : "";
  const arbitreNom = it.jugeArbitre?.nom && it.jugeArbitre.nom !== "null" ? it.jugeArbitre.nom : "";
  const arbitre = [arbitrePrenom, arbitreNom].filter(Boolean).join(" ");
  setDetailValue(card, ".arbitre-text", arbitre);

  // Surface / Nature terrain
  const surfaces = (it.naturesTerrains || [])
    .map((t) => t.libelle || t.code)
    .filter(Boolean)
    .join(", ");
  setDetailValue(card, ".surface-text", surfaces);

  // Prix lots
  const prixLot = it.prixLot && it.prixLot > 0 ? `${it.prixLot} €` : "";
  const prixEspece = it.prixEspece && it.prixEspece > 0 ? `${it.prixEspece} € espèces` : "";
  const prix = [prixLot, prixEspece].filter(Boolean).join(" + ");
  setDetailValue(card, ".prix-lots", prix);

  // Date ouverture inscription
  const dateOuverture = it.dateOuvertureInscriptionEnLigne
    ? new Date(it.dateOuvertureInscriptionEnLigne).toLocaleDateString("fr-FR")
    : "";
  setDetailValue(card, ".date-ouverture", dateOuverture);

  // Épreuves détaillées
  const epreuvesContainer = card.querySelector(".epreuves-list");
  const epreuves = it.epreuves || [];

  if (epreuves.length > 0) {
    epreuves.slice(0, 6).forEach((e) => {
      const nature = formatNature(e.natureEpreuve);
      const libelle = e.libelle || nature;
      const age = formatNature(e.categorieAge);
      const rangeBas = e.classementBas?.libelle?.trim() || "";
      const rangeHaut = e.classementHaut?.libelle?.trim() || "";
      const classement = rangeBas && rangeHaut ? `${rangeBas} → ${rangeHaut}` : "";
      const tarifAdulte = e.tarifAdulte ? `${e.tarifAdulte}€` : "";
      const tarifJeune = e.tarifJeune ? `${e.tarifJeune}€ jeune` : "";
      const tarif = [tarifAdulte, tarifJeune].filter(Boolean).join(" / ");

      const item = document.createElement("div");
      item.className = "epreuve-item";

      const infoDiv = document.createElement("div");
      infoDiv.className = "epreuve-info";

      const nameSpan = document.createElement("span");
      nameSpan.className = "epreuve-name";
      nameSpan.textContent = libelle;
      infoDiv.appendChild(nameSpan);

      if (classement || age) {
        const detailSpan = document.createElement("span");
        detailSpan.className = "epreuve-detail";
        detailSpan.textContent = [age !== "Senior" ? age : "", classement].filter(Boolean).join(" • ");
        infoDiv.appendChild(detailSpan);
      }

      item.appendChild(infoDiv);

      if (tarif) {
        const priceSpan = document.createElement("span");
        priceSpan.className = "epreuve-price";
        priceSpan.textContent = tarif;
        item.appendChild(priceSpan);
      }

      epreuvesContainer.appendChild(item);
    });

    // Show count if more
    if (epreuves.length > 6) {
      const more = document.createElement("div");
      more.className = "epreuve-item";
      more.style.justifyContent = "center";
      more.style.color = "var(--text-muted)";
      more.textContent = `+ ${epreuves.length - 6} autres épreuves`;
      epreuvesContainer.appendChild(more);
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "epreuve-item";
    empty.style.justifyContent = "center";
    empty.style.color = "var(--text-muted)";
    empty.textContent = "Aucune épreuve détaillée";
    epreuvesContainer.appendChild(empty);
  }

  // Contact - Email avec lien cliquable
  const email = it.courrielEngagement || it.contact?.courriel || "";
  const emailLink = card.querySelector(".contact-email");
  const emailText = card.querySelector(".email-text");
  if (email) {
    emailLink.href = `mailto:${email}`;
    emailText.textContent = email;
  } else {
    emailLink.style.display = "none";
  }

  // Contact - Téléphone avec lien cliquable
  const phone = it.installation?.telephone || it.contact?.telBureau || "";
  const phoneLink = card.querySelector(".contact-phone");
  const phoneText = card.querySelector(".phone-text");
  if (phone) {
    // Format phone for tel: link (remove spaces)
    const phoneClean = phone.replace(/\s+/g, "").replace(/\./g, "");
    phoneLink.href = `tel:${phoneClean}`;
    phoneText.textContent = formatPhone(phone);
  } else {
    phoneLink.style.display = "none";
  }

  // Meta
  card.querySelector(".meta-code").textContent = it.code || it.originalId || "";

  return node;
}

// Format phone number for display (XX XX XX XX XX)
function formatPhone(phone) {
  if (!phone) return "";
  const clean = phone.replace(/\D/g, "");
  if (clean.length === 10) {
    return clean.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4 $5");
  }
  return phone;
}

// Set detail value and hide row if empty
function setDetailValue(card, selector, value) {
  const el = card.querySelector(selector);
  if (el) {
    el.textContent = value || "";
    // Hide parent detail-row if empty
    if (!value && el.closest(".detail-row")) {
      el.closest(".detail-row").style.display = "none";
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════

// Filter inputs
[searchInput, levelSelect, eTypeSelect, maxDistanceInput, radiusInput, sortSelect, startDateInput, endDateInput]
  .forEach((el) => el?.addEventListener("input", render));

[levelSelect, eTypeSelect, sortSelect, startDateInput, endDateInput]
  .forEach((el) => el?.addEventListener("change", render));

// ═══════════════════════════════════════════════════════════════════════════
// RESET LOGIC
// ═══════════════════════════════════════════════════════════════════════════

function resetFilters() {
  searchInput.value = "";
  levelSelect.value = "";
  eTypeSelect.value = "";
  maxDistanceInput.value = "";
  radiusInput.value = "";
  locNameInput.value = "";
  locLatInput.value = "";
  locLngInput.value = "";

  // Sync Flatpickr
  if (typeof fpStart !== 'undefined') fpStart.setDate(today);
  if (typeof fpEnd !== 'undefined') fpEnd.setDate(inThreeMonths);

  render();
}

resetBtn?.addEventListener("click", resetFilters);

// View toggle buttons
viewListBtn?.addEventListener("click", () => setView("list"));
viewMapBtn?.addEventListener("click", () => setView("map"));

// Update map when radius changes
radiusInput?.addEventListener("input", () => {
  const lat = locLatInput.value;
  const lng = locLngInput.value;
  const radius = radiusInput.value;
  if (lat && lng && radius && currentView === 'map') {
    updateSearchCircle(parseFloat(lat), parseFloat(lng), parseFloat(radius));
  }
});


// Main search button
searchRemoteBtn?.addEventListener("click", async () => {
  const city = locNameInput.value.trim();
  if (!city) {
    summaryEl.textContent = "⚠️ Renseigne une ville pour lancer la recherche";
    return;
  }

  // Set loading state
  resultsSection?.classList.add("loading");
  mapLoader?.classList.add("active");
  summaryEl.textContent = "Géocodage en cours...";
  resultsEl.innerHTML = "";

  // Geocode city
  const geo = await geocodeCity(city);
  if (!geo || Number.isNaN(geo.lat) || Number.isNaN(geo.lng)) {
    summaryEl.textContent = "❌ Ville non trouvée, essaie avec un nom plus précis";
    resultsSection?.classList.remove("loading");
    mapLoader?.classList.remove("active");
    return;
  }

  // Update hidden fields
  locLatInput.value = geo.lat.toFixed(4);
  locLngInput.value = geo.lng.toFixed(4);
  locNameInput.value = geo.name;

  // Build query params
  const params = new URLSearchParams({
    lat: geo.lat,
    lng: geo.lng,
    rayon_km: radiusInput.value || "100",
    q: geo.name,
  });

  if (levelSelect.value) params.set("level", levelSelect.value);
  if (eTypeSelect.value) params.set("etype", eTypeSelect.value);
  if (startDateInput.value) params.set("date_start", startDateInput.value);
  if (endDateInput.value) params.set("date_end", endDateInput.value);

  summaryEl.textContent = "Interrogation TenUp en cours...";

  try {
    const resp = await fetch(`${API_BASE}/api/tenup/search?${params.toString()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    const items = data.items || [];

    // Pass geocoded coordinates for map auto-zoom
    const searchParams = { lat: geo.lat, lng: geo.lng };
    dedupeAndSet(items, { remote: true, params: searchParams });

    if (items.length === 0) {
      summaryEl.textContent = "Aucun tournoi trouvé pour ces critères";
    }
  } catch (e) {
    summaryEl.textContent = "❌ Erreur lors de la recherche";
    console.error(e);
  } finally {
    resultsSection?.classList.remove("loading");
    mapLoader?.classList.remove("active");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

// Set default dates (today + 3 months)
const today = new Date();
const inThreeMonths = new Date();
inThreeMonths.setMonth(inThreeMonths.getMonth() + 3);

startDateInput.value = today.toISOString().split("T")[0];
endDateInput.value = inThreeMonths.toISOString().split("T")[0];

// Initialize Map
setTimeout(() => {
  initMap();
}, 100);

// Initialize Flatpickr calendars
const fpConfig = {
  locale: "fr",
  dateFormat: "Y-m-d",
  altInput: true,
  altFormat: "j F Y",
  theme: "dark",
  disableMobile: "true", // Force custom picker on mobile too
  onChange: function (selectedDates, dateStr, instance) {
    render();
  }
};

const fpStart = flatpickr("#start-date", {
  ...fpConfig,
  defaultDate: today,
});

const fpEnd = flatpickr("#end-date", {
  ...fpConfig,
  defaultDate: inThreeMonths,
});

// Sync reset button with flatpickr is now handled in resetFilters

/* ═══════════════════════════════════════════════════════════════════════════
   MOBILE UI LOGIC
   ═══════════════════════════════════════════════════════════════════════════ */

function initMobileUI() {
  const btnFilter = document.getElementById('mobile-filter-toggle');
  const sidebar = document.querySelector('.sidebar');
  const btnMap = document.getElementById('mobile-view-map');
  const btnList = document.getElementById('mobile-view-list');

  // Default view on mobile: Map
  if (window.innerWidth <= 768) {
    document.body.classList.add('view-map');
  }

  // Toggle Sidebar (Modal)
  if (btnFilter) {
    btnFilter.addEventListener('click', () => {
      sidebar.classList.toggle('active');
    });
  }

  // Close sidebar when clicking outside (on map/content)
  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 768 &&
      sidebar && sidebar.classList.contains('active') &&
      !sidebar.contains(e.target) &&
      !btnFilter.contains(e.target)) {
      sidebar.classList.remove('active');
    }
  });

  // Switch to Map View
  if (btnMap) {
    btnMap.addEventListener('click', () => {
      const mainContent = document.querySelector('.content-main');
      mainContent.classList.add('view-changing');

      setTimeout(() => {
        document.body.classList.add('view-map');
        document.body.classList.remove('view-list');
        btnMap.classList.add('active');
        if (btnList) btnList.classList.remove('active');

        setTimeout(() => {
          if (window.map) window.map.invalidateSize();
          mainContent.classList.remove('view-changing');
        }, 50);
      }, 100);
    });
  }

  // Switch to List View
  if (btnList) {
    btnList.addEventListener('click', () => {
      const mainContent = document.querySelector('.content-main');
      mainContent.classList.add('view-changing');

      setTimeout(() => {
        document.body.classList.remove('view-map');
        document.body.classList.add('view-list');
        btnList.classList.add('active');
        if (btnMap) btnMap.classList.remove('active');
        mainContent.classList.remove('view-changing');
      }, 150);
    });
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initMobileUI();
  render();
});

function showEmptyState() {
  const isInitial = rawItems.length === 0;
  const title = isInitial ? "Bienvenue sur Padel Finder Pro" : "Aucun tournoi trouvé";
  const desc = isInitial
    ? "Commencez par entrer une ville dans la barre de recherche pour découvrir les tournois à proximité."
    : "Essayez de modifier vos filtres ou d'élargir votre zone de recherche pour trouver plus de résultats.";

  const icon = isInitial
    ? `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>`
    : `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4.5 16.5c-1.5 1.26-2 2.67-2 3.5 0 1 2 1 2 1s.5-1 1-1h13c.5 0 1 1 1 1s2 0 2-1c0-.83-.5-2.24-2-3.5"></path><path d="M15 14.5c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2z"></path><path d="M9 14.5c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2z"></path><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM12 20c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"></path></svg>`;

  resultsEl.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">
        ${icon}
      </div>
      <h3>${title}</h3>
      <p>${desc}</p>
    </div>
  `;
}

