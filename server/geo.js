// geo.js — distance and directions. No map service is called here.

// Haversine: straight-line distance in km between two {lat, lng} points.
// [Design choice] Straight-line distance, not travel time. Travel time needs a
// routing service (Google's traffic-aware routing is paid after a free
// allowance) and is a production step.
function distanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Google Maps directions link. Free, no API key (Google's "Maps URLs").
// On a phone with Google Maps installed it opens the app.
function navigateUrl(to) {
  return `https://www.google.com/maps/dir/?api=1&destination=${to.lat},${to.lng}&travelmode=driving`;
}

const round1 = (n) => Math.round(n * 10) / 10;

module.exports = { distanceKm, navigateUrl, round1 };
