CYKLOPLÁNOVAČ – cyklistický plánovač a GPS navigace v Leafletu
================================================================

Samostatná webová aplikace bez build systému: HTML5, CSS3, vanilla JavaScript,
Leaflet 1.9.4, OpenStreetMap, Valhalla (profil bicycle), Geolocation API,
Web Speech API a Screen Wake Lock API.

STRUKTURA
---------
cykloplanovac/
  index.html
  style.css
  app.js
  README.txt
  data/cyklotrasy.geojson   <- ZDE JE POUZE UKÁZKOVÝ SOUBOR, nahraďte jej svým
                               souborem s cyklotrasami (FeatureCollection,
                               LineString / MultiLineString, properties:
                               name, ref, network, operator, colour)

NASAZENÍ
--------
Zkopírujte celý adresář na HTTPS webserver. Geolokace funguje jen na HTTPS
(nebo na http://localhost při vývoji). Soubor data/cyklotrasy.geojson se
načítá přes fetch(), proto aplikaci neotvírejte přes file://, ale přes server,
např. při vývoji:  python3 -m http.server 8000  a  http://localhost:8000

POUŽITÍ
-------
1. Po otevření se automaticky zjistí poloha a nastaví se START (modré S
   s kruhem přesnosti GPS). Start je vždy aktuální GPS poloha; ruční start
   není. Před každým výpočtem trasy se poloha obnoví.
2. Klepnutí do mapy nastaví CÍL (červené C). Klepnutím lze cíl změnit.
   Klepnutí na cyklotrasu otevře popup (číslo, síť, provozovatel) a tlačítko
   "Nastavit cíl sem".
3. "Vypočítat trasu" -> červená trasa, vzdálenost a odhadovaný čas.
4. "Spustit navigaci" -> panel se zmenší na kompaktní navigační kartu,
   běží watchPosition(), hlasové pokyny (300 / 100 / 30 m před manévrem),
   kontrola odchylky a automatický přepočet.
5. "Ukončit navigaci" vrátí plánovací panel. "Nová trasa" smaže cíl a trasu.

NASTAVENÍ (konstanty na začátku app.js)
---------------------------------------
ROUTER_URL                 Valhalla endpoint
OFF_ROUTE_THRESHOLD_M      60   odchylka od trasy pro přepočet
MAX_GPS_ACCURACY_M         80   přepočet jen při přesnosti GPS lepší než tato
REROUTE_COOLDOWN_MS        20000 minimální odstup dvou přepočtů
ARRIVAL_DISTANCE_M         35   dosažení cíle

TESTOVÁNÍ BEZ REÁLNÉ JÍZDY
--------------------------
Akceptační scénář: START (GPS) 49.23477, 16.58850 / CÍL 49.24097, 16.56970.
Ve vývojářských nástrojích lze polohu nasimulovat (Sensors / Location).

Po spuštění navigace lze v konzoli simulovat GPS:

  const s = cykloDebug.getState();
  const p = s.routeCoordinates[10];            // [lng, lat]
  cykloDebug.simulatePosition(p[1], p[0], 8);  // bod na trase, přesnost 8 m

Test automatického přepočtu:

  // bod cca 100 m severně od libovolného bodu trasy, přesnost 10 m
  cykloDebug.simulatePosition(p[1] + 0.0009, p[0], 10);

V záložce Network se objeví nový požadavek na Valhallu, jehož první
location je simulovaná poloha a druhá původní cíl. Po úspěšné odpovědi se
stará trasa nahradí novou (bez fitBounds). Další přepočet je možný až po
20 s. cykloDebug.simulatePosition() funguje jen během navigace.

OMEZENÍ WEBOVÉ NAVIGACE
-----------------------
Aplikace počítá s telefonem v držáku, otevřenou aplikací a zapnutým
displejem. Wake Lock se pokouší displej udržet zapnutý (pokud jej zařízení
podporuje), ale GPS navigace nemůže spolehlivě fungovat při zhasnutém
telefonu, dlouhodobém běhu na pozadí ani při uspání záložky prohlížeče.
Hlasové pokyny využívají českou hlasovou syntézu zařízení (cs-CZ); pokud ji
zařízení nemá, hlas může chybět nebo mluvit jiným jazykem.

POZNÁMKA K VALHALLE
-------------------
Veřejný server valhalla1.openstreetmap.de je určen pro rozumné využití
a může být nedostupný nebo omezovat počet požadavků. Pro ostrý provoz zvažte
vlastní instanci Valhally a změňte ROUTER_URL.

LICENCE DAT
-----------
Podkladová mapa a data tras: © přispěvatelé OpenStreetMap (ODbL).
