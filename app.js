/* Cykloplánovač – app.js
   Vanilla JS + Leaflet 1.9.4 + Valhalla (bicycle) + Geolocation + Web Speech + Wake Lock.

   Souřadnice:  Leaflet = [lat, lng]   GeoJSON / routeCoordinates = [lng, lat]
   Valhalla encoded polyline se dekóduje s precision 6. */

(function () {
    'use strict';

    // ======================================================================
    // Konstanty
    // ======================================================================

    const ROUTER_URL = 'https://valhalla1.openstreetmap.de/route';
    const OFF_ROUTE_THRESHOLD_M = 60;
    const MAX_GPS_ACCURACY_M = 80;
    const REROUTE_COOLDOWN_MS = 20000;
    const ARRIVAL_DISTANCE_M = 35;
    const ROUTE_TIMEOUT_MS = 20000;
    const VOICE_THRESHOLDS = [300, 100, 30];
    const LAT_SCALE = 111320;
    const NAV_STATUS_DEFAULT = 'Navigace běží';

    const routeColors = {
        icn: '#d7191c',
        ncn: '#f57c00',
        rcn: '#1976d2',
        lcn: '#2e7d32',
        mtb: '#7b1fa2',
        other: '#68737d'
    };

    const networkLabels = {
        icn: 'mezinárodní',
        ncn: 'národní',
        rcn: 'regionální',
        lcn: 'místní',
        mtb: 'MTB',
        other: 'neurčeno'
    };

    // ======================================================================
    // Stav aplikace
    // ======================================================================

    let startPoint = null;
    let finishPoint = null;
    let startMarker = null;
    let finishMarker = null;
    let routeLayer = null;
    let currentMarker = null;
    let routeCoordinates = [];     // [[lng, lat], ...]
    let routeCumulative = [];      // metry od začátku trasy
    let maneuvers = [];
    let navigating = false;
    let watchId = null;
    let rerouting = false;
    let lastRerouteAt = 0;
    let lastSpokenKey = '';
    let wakeLock = null;

    let accuracyCircle = null;
    let routeTimeSec = 0;
    let routeLengthKm = 0;
    let calculating = false;
    let locating = false;
    let routeToken = 0;            // zneplatní rozpracované požadavky
    let lastSegIndex = null;
    let lastPosition = null;
    let firstFix = true;
    let statusTimer = null;
    const spokenKeys = new Set();

    // ======================================================================
    // DOM
    // ======================================================================

    function byId(id) {
        return document.getElementById(id);
    }

    const dom = {
        planner: byId('planner'),
        togglePlannerBtn: byId('togglePlannerBtn'),
        startInfo: byId('startInfo'),
        finishInfo: byId('finishInfo'),
        calcBtn: byId('calcBtn'),
        startNavBtn: byId('startNavBtn'),
        stopNavBtn: byId('stopNavBtn'),
        newRouteBtn: byId('newRouteBtn'),
        voiceToggle: byId('voiceToggle'),
        hint: byId('hint'),
        message: byId('message'),
        routeSummary: byId('routeSummary'),
        routeDistance: byId('routeDistance'),
        routeTime: byId('routeTime'),
        maneuverIcon: byId('maneuverIcon'),
        maneuverDistance: byId('maneuverDistance'),
        maneuverText: byId('maneuverText'),
        remainingDistance: byId('remainingDistance'),
        remainingTime: byId('remainingTime'),
        offRouteDistance: byId('offRouteDistance'),
        gpsAccuracy: byId('gpsAccuracy'),
        navigationStatus: byId('navigationStatus')
    };

    // ======================================================================
    // Pomocné funkce
    // ======================================================================

    function esc(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDistance(meters) {
        if (!isFinite(meters)) { return '–'; }
        if (meters < 1000) {
            const rounded = meters >= 100 ? Math.round(meters / 10) * 10 : Math.round(meters);
            return rounded + ' m';
        }
        return (meters / 1000).toFixed(1).replace('.', ',') + ' km';
    }

    function formatDuration(seconds) {
        if (!isFinite(seconds)) { return '–'; }
        const minutes = Math.round(seconds / 60);
        if (minutes < 1) { return '<1 min'; }
        if (minutes < 60) { return minutes + ' min'; }
        return Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min';
    }

    function formatPoint(p) {
        return p.lat.toFixed(5) + ', ' + p.lng.toFixed(5);
    }

    function haversine(lat1, lng1, lat2, lng2) {
        const R = 6371008.8;
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad;
        const dLng = (lng2 - lng1) * toRad;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    function lcfirst(text) {
        return text.charAt(0).toLowerCase() + text.slice(1);
    }

    function scheduleInvalidate() {
        setTimeout(function () {
            map.invalidateSize();
        }, 150);
    }

    // ======================================================================
    // Zprávy
    // ======================================================================

    function setMessage(text, isError) {
        dom.message.textContent = text || '';
        dom.message.classList.toggle('error', !!isError);
        dom.message.hidden = !text;
    }

    function setNavStatus(text, ttlMs) {
        dom.navigationStatus.textContent = text;
        if (statusTimer) {
            clearTimeout(statusTimer);
            statusTimer = null;
        }
        if (ttlMs) {
            statusTimer = setTimeout(function () {
                statusTimer = null;
                dom.navigationStatus.textContent = NAV_STATUS_DEFAULT;
            }, ttlMs);
        }
    }

    // Za jízdy se zprávy ukazují v navigační kartě, jinak v panelu plánování.
    function notify(text, isError) {
        if (navigating) {
            setNavStatus(text, isError ? 8000 : 6000);
        } else {
            setMessage(text, isError);
        }
    }

    function updateHint() {
        dom.hint.textContent = !finishPoint
            ? 'Start je vaše aktuální poloha (GPS). Klepnutím do mapy zvolte cíl.'
            : 'Vypočítejte trasu, nebo cíl změňte dalším klepnutím do mapy.';
    }

    function updateButtons() {
        dom.calcBtn.disabled = !finishPoint || calculating || navigating;
        dom.startNavBtn.disabled = routeCoordinates.length < 2 || navigating;
        dom.stopNavBtn.hidden = !navigating;
        dom.newRouteBtn.disabled = navigating;
    }

    // ======================================================================
    // Mapa
    // ======================================================================

    if (typeof L === 'undefined') {
        setMessage('Knihovna Leaflet se nenačetla. Zkontrolujte připojení k internetu.', true);
        return;
    }

    const map = L.map('map', {
        center: [49.1951, 16.6068],
        zoom: 11,
        preferCanvas: true,
        zoomControl: false
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    // ---------- Vrstva cyklotras (pouze vizualizace) ----------

    const NETWORK_ORDER = { other: 0, lcn: 1, mtb: 2, rcn: 3, ncn: 4, icn: 5 };

    function networkKey(feature) {
        const raw = feature && feature.properties && feature.properties.network;
        const key = String(raw || '').toLowerCase().split(';')[0].trim();
        return (key && key !== 'other' && Object.prototype.hasOwnProperty.call(routeColors, key)) ? key : 'other';
    }

    function cycleStyle(feature) {
        const key = networkKey(feature);
        return {
            color: routeColors[key],
            weight: key === 'icn' ? 5 : (key === 'ncn' ? 4 : 3),
            opacity: 0.70
        };
    }

    function popupHtml(props) {
        props = props || {};
        const key = String(props.network || '').toLowerCase().split(';')[0].trim();
        const title = props.name ? esc(props.name) : 'Cyklotrasa';
        const rows = [];
        if (props.ref) { rows.push('Číslo: ' + esc(props.ref)); }
        if (props.network) {
            rows.push('Síť: ' + esc(networkLabels[key] || props.network));
        }
        if (props.operator) { rows.push('Provozovatel: ' + esc(props.operator)); }
        return '<div class="route-popup"><strong>' + title + '</strong>' +
            rows.map(function (r) { return '<div>' + r + '</div>'; }).join('') +
            '<button type="button" class="popup-btn">Nastavit cíl sem</button></div>';
    }

    function loadCycleRoutes() {
        fetch('data/cyklotrasy.geojson')
            .then(function (response) {
                if (!response.ok) { throw new Error('HTTP ' + response.status); }
                return response.json();
            })
            .then(function (data) {
                if (!data || !Array.isArray(data.features)) {
                    throw new Error('GeoJSON není FeatureCollection');
                }
                const sorted = data.features.slice().sort(function (a, b) {
                    return NETWORK_ORDER[networkKey(a)] - NETWORK_ORDER[networkKey(b)];
                });
                const layer = L.geoJSON({ type: 'FeatureCollection', features: sorted }, {
                    style: cycleStyle,
                    bubblingMouseEvents: false,
                    onEachFeature: function (feature, lyr) {
                        lyr.bindPopup(function () {
                            return popupHtml(feature.properties);
                        });
                    }
                }).addTo(map);
                layer.bringToBack();
                if (routeLayer) { routeLayer.bringToFront(); }
            })
            .catch(function (err) {
                // Vrstva cyklotras je jen doplněk – routing zůstává použitelný.
                console.error('Cyklotrasy se nepodařilo načíst', err);
            });
    }

    // ======================================================================
    // Markery start / cíl
    // ======================================================================

    function pinIcon(letter, cls) {
        return L.divIcon({
            className: 'pin ' + cls,
            html: '<span>' + letter + '</span>',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });
    }

    // Nastaví start bez zneplatnění trasy (používá i rerouting).
    function placeStart(lat, lng, accuracy) {
        startPoint = { lat: lat, lng: lng };

        if (startMarker) {
            startMarker.setLatLng([lat, lng]);
        } else {
            startMarker = L.marker([lat, lng], { icon: pinIcon('S', 'pin-start'), title: 'Start' }).addTo(map);
        }

        const hasAccuracy = typeof accuracy === 'number' && isFinite(accuracy);
        if (hasAccuracy) {
            if (accuracyCircle) {
                accuracyCircle.setLatLng([lat, lng]);
                accuracyCircle.setRadius(accuracy);
            } else {
                accuracyCircle = L.circle([lat, lng], {
                    radius: accuracy,
                    color: '#1565c0',
                    weight: 1,
                    fillColor: '#1565c0',
                    fillOpacity: 0.12,
                    interactive: false
                }).addTo(map);
            }
        } else if (accuracyCircle) {
            map.removeLayer(accuracyCircle);
            accuracyCircle = null;
        }

        dom.startInfo.textContent = formatPoint(startPoint) +
            (hasAccuracy ? ' (GPS ±' + Math.round(accuracy) + ' m)' : ' (GPS)');
    }

    function setStart(lat, lng, accuracy) {
        placeStart(lat, lng, accuracy);
        invalidateRoute();
        updateHint();
        updateButtons();
    }

    function setFinish(lat, lng) {
        finishPoint = { lat: lat, lng: lng };
        if (finishMarker) {
            finishMarker.setLatLng([lat, lng]);
        } else {
            finishMarker = L.marker([lat, lng], { icon: pinIcon('C', 'pin-finish'), title: 'Cíl' }).addTo(map);
        }
        dom.finishInfo.textContent = formatPoint(finishPoint);
        invalidateRoute();
        updateHint();
        updateButtons();
    }

    // ======================================================================
    // GPS start
    // ======================================================================

    function permissionMessage() {
        return 'Přístup k poloze nebyl povolen. Povolte polohu v nastavení prohlížeče.';
    }

    function acquirePosition(maxAgeMs) {
        return new Promise(function (resolve, reject) {
            if (!('geolocation' in navigator)) {
                reject({ code: 2 });
                return;
            }
            navigator.geolocation.getCurrentPosition(function (pos) {
                resolve(pos.coords);
            }, reject, {
                enableHighAccuracy: true,
                timeout: 12000,
                maximumAge: maxAgeMs
            });
        });
    }

    // Po otevření aplikace: START = aktuální GPS.
    function locateStart() {
        acquirePosition(30000).then(function (c) {
            if (navigating) { return; }
            setStart(c.latitude, c.longitude, c.accuracy);
            map.setView([c.latitude, c.longitude], Math.max(map.getZoom(), 14));
            setMessage('');
        }, function (err) {
            console.error('Geolokace selhala', err);
            setMessage(err && err.code === 1 ? permissionMessage() : 'Poloha není dostupná.', true);
        });
    }

    // ======================================================================
    // Valhalla – dekódování a parsování
    // ======================================================================

    // Vrací [[lng, lat], ...] (GeoJSON pořadí).
    function decodePolyline(encoded, precision) {
        const factor = Math.pow(10, precision === undefined ? 6 : precision);
        const coords = [];
        let index = 0;
        let lat = 0;
        let lng = 0;

        while (index < encoded.length) {
            let byte;
            let shift = 0;
            let result = 0;

            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20 && index < encoded.length);
            lat += (result & 1) ? ~(result >> 1) : (result >> 1);

            shift = 0;
            result = 0;
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20 && index < encoded.length);
            lng += (result & 1) ? ~(result >> 1) : (result >> 1);

            coords.push([lng / factor, lat / factor]);
        }
        return coords;
    }

    // Podporuje: encoded polyline, {coordinates: [...]}, přímé pole koordinátů.
    function shapeToCoords(shape) {
        let raw;
        if (typeof shape === 'string') {
            raw = decodePolyline(shape, 6);
        } else if (shape && Array.isArray(shape.coordinates)) {
            raw = shape.coordinates;
        } else if (Array.isArray(shape)) {
            raw = shape;
        } else {
            throw new Error('Neznámý formát shape');
        }

        const coords = raw.map(function (p) {
            if (Array.isArray(p)) { return [Number(p[0]), Number(p[1])]; }              // [lng, lat]
            if (p && typeof p === 'object') {
                return [Number(p.lng !== undefined ? p.lng : p.lon), Number(p.lat)];
            }
            return [NaN, NaN];
        });

        coords.forEach(function (p) {
            if (!isFinite(p[0]) || !isFinite(p[1]) || Math.abs(p[1]) > 90 || Math.abs(p[0]) > 180) {
                throw new Error('Neplatná souřadnice v trase: ' + p);
            }
        });
        return coords;
    }

    function maneuverIconFor(type) {
        if ([4, 5, 6].indexOf(type) !== -1) { return '⚑'; }
        if ([26, 27].indexOf(type) !== -1) { return '↻'; }
        if ([3, 13, 14, 15, 16, 19, 21, 24, 38].indexOf(type) !== -1) { return '←'; }
        if ([2, 9, 10, 11, 12, 18, 20, 23, 37].indexOf(type) !== -1) { return '→'; }
        return '↑';
    }

    function isDestination(type) {
        return type === 4 || type === 5 || type === 6;
    }

    function parseRoute(data) {
        const trip = data && data.trip;
        if (!trip || !Array.isArray(trip.legs) || trip.legs.length === 0) {
            throw new Error('Neplatná odpověď routingu');
        }

        const coordinates = [];
        const parsedManeuvers = [];

        trip.legs.forEach(function (leg) {
            const legCoords = shapeToCoords(leg.shape);
            // První bod dalšího legu je shodný s posledním bodem předchozího – nevkládat dvakrát.
            const offset = coordinates.length > 0 ? coordinates.length - 1 : 0;
            Array.prototype.push.apply(coordinates, coordinates.length > 0 ? legCoords.slice(1) : legCoords);

            (leg.maneuvers || []).forEach(function (m) {
                parsedManeuvers.push({
                    type: m.type,
                    text: m.instruction || 'Pokračujte',
                    verbal: m.verbal_pre_transition_instruction || m.instruction || 'Pokračujte',
                    streets: m.street_names || [],
                    length: m.length,
                    time: m.time,
                    globalBegin: offset + m.begin_shape_index,
                    globalEnd: offset + m.end_shape_index
                });
            });
        });

        if (coordinates.length < 2) {
            throw new Error('Trasa neobsahuje dost bodů');
        }

        let lengthKm;
        let timeSec;
        if (trip.summary && isFinite(trip.summary.length) && isFinite(trip.summary.time)) {
            lengthKm = trip.summary.length;
            timeSec = trip.summary.time;
        } else {
            lengthKm = 0;
            timeSec = 0;
            trip.legs.forEach(function (leg) {
                if (leg.summary) {
                    lengthKm += Number(leg.summary.length) || 0;
                    timeSec += Number(leg.summary.time) || 0;
                }
            });
        }

        return {
            coordinates: coordinates,
            maneuvers: parsedManeuvers,
            lengthKm: lengthKm,
            timeSec: timeSec
        };
    }

    function fetchRoute(from, to) {
        const request = {
            locations: [
                { lat: from.lat, lon: from.lng },
                { lat: to.lat, lon: to.lng }
            ],
            costing: 'bicycle',
            units: 'kilometers',
            language: 'cs-CZ',
            directions_type: 'instructions'
        };

        const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = setTimeout(function () {
            if (controller) { controller.abort(); }
        }, ROUTE_TIMEOUT_MS);

        return fetch(
            ROUTER_URL + '?json=' + encodeURIComponent(JSON.stringify(request)),
            controller ? { signal: controller.signal } : undefined
        ).then(function (response) {
            if (!response.ok) { throw new Error('Routing HTTP ' + response.status); }
            return response.json();
        }).then(parseRoute).then(function (route) {
            clearTimeout(timer);
            return route;
        }, function (err) {
            clearTimeout(timer);
            throw err;
        });
    }

    // ======================================================================
    // Trasa: kumulativní délka, vykreslení, aplikace výsledku
    // ======================================================================

    function computeCumulative(coords) {
        const cumulative = [0];
        for (let i = 1; i < coords.length; i++) {
            cumulative.push(cumulative[i - 1] +
                haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
        }
        return cumulative;
    }

    function totalRouteDistance() {
        return routeCumulative.length ? routeCumulative[routeCumulative.length - 1] : 0;
    }

    function clearRouteLayer() {
        if (routeLayer) {
            map.removeLayer(routeLayer);
            routeLayer = null;
        }
    }

    function invalidateRoute() {
        routeToken++;
        clearRouteLayer();
        routeCoordinates = [];
        routeCumulative = [];
        maneuvers = [];
        routeTimeSec = 0;
        routeLengthKm = 0;
        lastSegIndex = null;
        dom.routeSummary.hidden = true;
        updateButtons();
    }

    function applyRoute(route, options) {
        clearRouteLayer();

        routeCoordinates = route.coordinates;
        routeCumulative = computeCumulative(routeCoordinates);
        maneuvers = route.maneuvers;
        routeTimeSec = route.timeSec;
        routeLengthKm = route.lengthKm;
        lastSegIndex = null;
        lastSpokenKey = '';
        spokenKeys.clear();

        const feature = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: routeCoordinates }   // [lng, lat]
        };

        routeLayer = L.geoJSON(feature, {
            interactive: false,
            style: function () {
                return {
                    color: '#ff1744',
                    weight: 7,
                    opacity: 0.94,
                    lineCap: 'round',
                    lineJoin: 'round'
                };
            }
        }).addTo(map);
        routeLayer.bringToFront();

        dom.routeDistance.textContent = formatDistance(routeLengthKm * 1000);
        dom.routeTime.textContent = formatDuration(routeTimeSec);
        dom.routeSummary.hidden = false;

        if (options && options.fit) {
            map.fitBounds(routeLayer.getBounds(), { padding: [35, 35] });
        }
        updateButtons();
    }

    // START je vždy aktuální GPS: před výpočtem se poloha obnoví.
    function calculateRoute() {
        if (!finishPoint || calculating || navigating) { return; }

        calculating = true;
        updateButtons();
        setMessage('Zjišťuji polohu…');

        acquirePosition(5000).then(function (c) {
            setStart(c.latitude, c.longitude, c.accuracy);
        }, function (err) {
            console.error('Geolokace selhala', err);
            if (!startPoint) { throw err; }       // jinak použij poslední známou GPS polohu
        }).then(function () {
            setMessage('Počítám trasu…');
            const token = ++routeToken;
            return fetchRoute(startPoint, finishPoint).then(function (route) {
                if (token !== routeToken) { return; }    // mezitím se změnil cíl
                applyRoute(route, { fit: true });
                setMessage('');
            });
        }).catch(function (err) {
            console.error('Routing selhal', err);
            if (err && typeof err.code === 'number') {
                setMessage(err.code === 1 ? permissionMessage() : 'Poloha není dostupná.', true);
            } else {
                setMessage('Trasu nelze vypočítat.', true);
            }
        }).then(function () {
            calculating = false;
            updateButtons();
        });
    }

    // ======================================================================
    // Vzdálenost od trasy
    // ======================================================================

    // position = { lat, lng }. Vrací { distance, index, along } nebo null.
    function nearestOnRoute(position) {
        const n = routeCoordinates.length;
        if (n < 2) { return null; }

        const lat = position.lat;
        const lng = position.lng;
        const lngScale = LAT_SCALE * Math.cos(lat * Math.PI / 180);

        function scan(from, to) {
            let best = null;
            for (let i = from; i < to; i++) {
                const a = routeCoordinates[i];
                const b = routeCoordinates[i + 1];
                const ax = (a[0] - lng) * lngScale;
                const ay = (a[1] - lat) * LAT_SCALE;
                const bx = (b[0] - lng) * lngScale;
                const by = (b[1] - lat) * LAT_SCALE;
                const dx = bx - ax;
                const dy = by - ay;
                const len2 = dx * dx + dy * dy;
                let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
                t = Math.max(0, Math.min(1, t));
                const px = ax + t * dx;
                const py = ay + t * dy;
                const d = Math.sqrt(px * px + py * py);
                if (!best || d < best.distance) {
                    best = { distance: d, index: i, t: t };
                }
            }
            return best;
        }

        // Nejdřív okolí posledního známého segmentu (trasa se může sama křížit),
        // celé prohledání jen když okno nenajde nic blízkého.
        let best = null;
        if (lastSegIndex !== null) {
            const windowBest = scan(Math.max(0, lastSegIndex - 10), Math.min(n - 1, lastSegIndex + 150));
            if (windowBest && windowBest.distance <= 40) { best = windowBest; }
        }
        if (!best) { best = scan(0, n - 1); }

        const segLen = routeCumulative[best.index + 1] - routeCumulative[best.index];
        return {
            distance: best.distance,
            index: best.index,
            along: routeCumulative[best.index] + best.t * segLen
        };
    }

    // ======================================================================
    // Hlasové pokyny
    // ======================================================================

    function speak(text) {
        if (!dom.voiceToggle.checked) { return; }
        if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') { return; }
        try {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'cs-CZ';
            utterance.rate = 1;
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(utterance);
        } catch (err) {
            console.error('Hlasový výstup selhal', err);
        }
    }

    function cancelSpeech() {
        if ('speechSynthesis' in window) {
            try { window.speechSynthesis.cancel(); } catch (err) { /* ignoruj */ }
        }
    }

    function handleVoiceGuidance(idx, distance) {
        if (idx < 0) { return; }
        const m = maneuvers[idx];
        if (isDestination(m.type)) { return; }     // cíl hlásí detekce dosažení cíle

        let level = -1;
        for (let k = VOICE_THRESHOLDS.length - 1; k >= 0; k--) {
            if (distance <= VOICE_THRESHOLDS[k]) { level = k; break; }
        }
        if (level < 0) { return; }

        const key = idx + '-' + VOICE_THRESHOLDS[level];
        if (key === lastSpokenKey || spokenKeys.has(key)) { return; }

        // Hrubší prahy označit jako vyslovené, aby je GPS šum nevrátil zpět.
        for (let k = 0; k <= level; k++) {
            spokenKeys.add(idx + '-' + VOICE_THRESHOLDS[k]);
        }
        lastSpokenKey = key;

        let text = m.verbal;
        if (!/[.!?]$/.test(text)) { text += '.'; }
        if (VOICE_THRESHOLDS[level] > 30) {
            text = 'Za ' + VOICE_THRESHOLDS[level] + ' metrů ' + lcfirst(text);
        }
        speak(text);
    }

    // ======================================================================
    // Wake Lock
    // ======================================================================

    function requestWakeLock() {
        if (!navigating || wakeLock || !('wakeLock' in navigator)) { return; }
        try {
            navigator.wakeLock.request('screen').then(function (sentinel) {
                if (!navigating || wakeLock) {
                    sentinel.release().catch(function () { /* ignoruj */ });
                    return;
                }
                wakeLock = sentinel;
                sentinel.addEventListener('release', function () {
                    if (wakeLock === sentinel) { wakeLock = null; }
                });
            }).catch(function (err) {
                console.warn('Wake Lock odmítnut', err);
            });
        } catch (err) {
            console.warn('Wake Lock nelze použít', err);
        }
    }

    function releaseWakeLock() {
        if (wakeLock) {
            const sentinel = wakeLock;
            wakeLock = null;
            sentinel.release().catch(function () { /* ignoruj */ });
        }
    }

    // ======================================================================
    // Navigace
    // ======================================================================

    function findNextManeuver(along) {
        for (let i = 0; i < maneuvers.length; i++) {
            if (routeCumulative[maneuvers[i].globalBegin] > along + 3) { return i; }
        }
        return -1;
    }

    function updateNavigationPanel(position, near) {
        const total = totalRouteDistance();
        const remaining = Math.max(0, total - near.along);
        const ratio = total > 0 ? remaining / total : 0;

        dom.remainingDistance.textContent = formatDistance(remaining);
        dom.remainingTime.textContent = formatDuration(routeTimeSec * ratio);
        dom.offRouteDistance.textContent = formatDistance(near.distance);
        dom.gpsAccuracy.textContent = (typeof position.accuracy === 'number' && isFinite(position.accuracy))
            ? '±' + Math.round(position.accuracy) + ' m' : '–';

        const idx = findNextManeuver(near.along);
        if (idx >= 0) {
            const m = maneuvers[idx];
            const distance = routeCumulative[m.globalBegin] - near.along;
            dom.maneuverIcon.textContent = maneuverIconFor(m.type);
            dom.maneuverDistance.textContent = formatDistance(distance);
            dom.maneuverText.textContent = m.text;
        } else {
            dom.maneuverIcon.textContent = '↑';
            dom.maneuverDistance.textContent = formatDistance(remaining);
            dom.maneuverText.textContent = 'Pokračujte do cíle';
        }

        if (!statusTimer) {
            dom.navigationStatus.textContent = near.distance > OFF_ROUTE_THRESHOLD_M
                ? 'Jste mimo trasu' : NAV_STATUS_DEFAULT;
        }
        return idx;
    }

    function maybeReroute(position, distanceFromRoute) {
        if (distanceFromRoute <= OFF_ROUTE_THRESHOLD_M) { return; }
        if (!(position.accuracy < MAX_GPS_ACCURACY_M)) { return; }
        if (rerouting) { return; }
        if (Date.now() - lastRerouteAt < REROUTE_COOLDOWN_MS) { return; }
        if (!finishPoint) { return; }

        rerouting = true;
        lastRerouteAt = Date.now();
        const from = { lat: position.lat, lng: position.lng };    // START = aktuální GPS
        notify('Přepočítávám trasu…');

        fetchRoute(from, finishPoint).then(function (route) {   // CÍL = původní cíl
            if (!navigating) { return; }
            placeStart(from.lat, from.lng, null);
            applyRoute(route, { fit: false });                  // bez fitBounds
            notify('Trasa byla přepočítána.');
            speak('Trasa byla přepočítána.');
            if (lastPosition) {
                const near = nearestOnRoute(lastPosition);
                if (near) {
                    lastSegIndex = near.index;
                    updateNavigationPanel(lastPosition, near);
                }
            }
        }).catch(function (err) {
            console.error('Přepočet trasy selhal', err);
            if (navigating) {
                notify('Přepočet se nezdařil, pokračuji po původní trase.', true);
            }
        }).then(function () {
            rerouting = false;
        });
    }

    function onPosition(pos) {
        if (!navigating) { return; }

        const c = pos.coords;
        const position = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy };
        lastPosition = position;

        if (currentMarker) {
            currentMarker.setLatLng([position.lat, position.lng]);
        }

        if (firstFix) {
            firstFix = false;
            map.setView([position.lat, position.lng], Math.max(map.getZoom(), 17));
        } else {
            map.panTo([position.lat, position.lng], { animate: true, duration: 0.5 });
        }

        const near = nearestOnRoute(position);
        if (!near) { return; }
        lastSegIndex = near.index;

        const idx = updateNavigationPanel(position, near);

        // Dosažení cíle (musí být skutečně na konci trasy, ne jen blízko startu u okružní trasy)
        const end = routeCoordinates[routeCoordinates.length - 1];
        const toFinish = haversine(position.lat, position.lng, end[1], end[0]);
        const remainingAlong = totalRouteDistance() - near.along;
        if (toFinish < ARRIVAL_DISTANCE_M && remainingAlong < ARRIVAL_DISTANCE_M * 3) {
            speak('Dorazili jste do cíle.');
            stopNavigation();
            setMessage('Dorazili jste do cíle.');
            return;
        }

        handleVoiceGuidance(idx, idx >= 0 ? routeCumulative[maneuvers[idx].globalBegin] - near.along : Infinity);
        maybeReroute(position, near.distance);
    }

    function onPositionError(err) {
        console.error('watchPosition chyba', err);
        if (err && err.code === 1) {
            stopNavigation();
            setMessage('Přístup k poloze nebyl povolen. Použijte Start ručně.', true);
        } else {
            notify('Poloha není dostupná.', true);
        }
    }

    function stopWatch() {
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
    }

    function startWatch() {
        stopWatch();     // nikdy dva watchery současně
        watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 10000
        });
    }

    function startNavigation() {
        if (navigating || routeCoordinates.length < 2) { return; }
        if (!('geolocation' in navigator)) {
            setMessage('Poloha není dostupná.', true);
            return;
        }

        navigating = true;
        firstFix = true;
        lastPosition = null;
        lastSegIndex = null;
        lastSpokenKey = '';
        spokenKeys.clear();
        setMessage('');

        document.body.classList.add('navigation-mode');

        dom.maneuverIcon.textContent = '↑';
        dom.maneuverDistance.textContent = '–';
        dom.maneuverText.textContent = 'Čekám na GPS…';
        dom.remainingDistance.textContent = formatDistance(totalRouteDistance());
        dom.remainingTime.textContent = formatDuration(routeTimeSec);
        dom.offRouteDistance.textContent = '–';
        dom.gpsAccuracy.textContent = '–';
        setNavStatus(NAV_STATUS_DEFAULT);

        if (currentMarker) { map.removeLayer(currentMarker); }
        const origin = routeCoordinates[0];
        currentMarker = L.circleMarker([origin[1], origin[0]], {
            radius: 9,
            color: '#ffffff',
            weight: 3,
            fillColor: '#1565c0',
            fillOpacity: 1,
            interactive: false
        }).addTo(map);

        updateButtons();
        startWatch();
        requestWakeLock();
        scheduleInvalidate();

        // Úvodní pokyn; zároveň „odemkne“ SpeechSynthesis na iOS (běží z kliknutí).
        if (maneuvers.length) { speak(maneuvers[0].verbal); }
    }

    function stopNavigation() {
        navigating = false;
        stopWatch();
        releaseWakeLock();
        if (statusTimer) {
            clearTimeout(statusTimer);
            statusTimer = null;
        }
        if (currentMarker) {
            map.removeLayer(currentMarker);
            currentMarker = null;
        }
        document.body.classList.remove('navigation-mode');
        updateButtons();
        updateHint();
        scheduleInvalidate();
    }

    // ======================================================================
    // Události UI (registrují se jednou)
    // ======================================================================

    function newRoute() {
        if (navigating) { return; }
        invalidateRoute();
        if (finishMarker) {
            map.removeLayer(finishMarker);
            finishMarker = null;
        }
        finishPoint = null;
        dom.finishInfo.textContent = 'nenastaven';
        setMessage('');
        updateHint();
        updateButtons();
    }

    function bindEvents() {
        map.on('click', function (e) {
            if (navigating) { return; }
            setFinish(e.latlng.lat, e.latlng.lng);
        });

        map.on('popupopen', function (e) {
            const root = e.popup.getElement();
            const btn = root && root.querySelector('.popup-btn');
            if (!btn) { return; }
            const ll = e.popup.getLatLng();
            btn.onclick = function () {
                if (!navigating) { setFinish(ll.lat, ll.lng); }
                map.closePopup();
            };
        });

        dom.calcBtn.addEventListener('click', calculateRoute);

        dom.startNavBtn.addEventListener('click', startNavigation);

        dom.stopNavBtn.addEventListener('click', function () {
            cancelSpeech();
            stopNavigation();
        });

        dom.newRouteBtn.addEventListener('click', newRoute);

        dom.voiceToggle.addEventListener('change', function () {
            if (!dom.voiceToggle.checked) { cancelSpeech(); }
        });

        dom.togglePlannerBtn.addEventListener('click', function () {
            const collapsed = dom.planner.classList.toggle('collapsed');
            dom.togglePlannerBtn.textContent = collapsed ? '▸' : '▾';
            dom.togglePlannerBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            scheduleInvalidate();
        });

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && navigating) {
                requestWakeLock();
            }
        });

        window.addEventListener('orientationchange', scheduleInvalidate);
    }

    // ======================================================================
    // Start aplikace
    // ======================================================================

    if (!('speechSynthesis' in window)) {
        dom.voiceToggle.checked = false;
        dom.voiceToggle.disabled = true;
    }

    bindEvents();
    updateHint();
    updateButtons();
    loadCycleRoutes();
    locateStart();

    // Ladicí rozhraní: umožňuje otestovat navigaci a rerouting bez reálné jízdy
    // (viz README.txt).
    window.cykloDebug = {
        simulatePosition: function (lat, lng, accuracy) {
            if (!navigating) { return false; }
            onPosition({ coords: { latitude: lat, longitude: lng, accuracy: accuracy } });
            return true;
        },
        getState: function () {
            return {
                startPoint: startPoint,
                finishPoint: finishPoint,
                navigating: navigating,
                rerouting: rerouting,
                watchId: watchId,
                routeCoordinates: routeCoordinates,
                routeCumulative: routeCumulative,
                maneuvers: maneuvers
            };
        },
        decodePolyline: decodePolyline,
        nearestOnRoute: nearestOnRoute
    };
})();
