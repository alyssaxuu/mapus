$(document).ready(function(){
  // Coordinates to center the map. Could let the user choose when creating a room & persist when sharing a link (via GET params)
  const lat = 31.23070;
  const lon = 121.48696;

  // Initialize the Leaflet map
  var map = L.map('mapDiv', {
    renderer: L.canvas({ tolerance: 10 })
  }).setView([lat, lon], 13);
  L.PM.setOptIn(true);
  var currentUser = null;      // normalized Supabase user ({uid, displayName, photoURL})
  var userCache = {};          // user_id -> latest room_users row
  var onlineIds = null;        // set of uids currently online (Realtime Presence)
  var presenceChannel = null;
  var dataLoaded = false;
  var mapname = "";
  var oldname = "";
  var mapdescription = "";
  var olddescription = "";
  var editingname = false;
  var editingdescription = false;
  var dragging = false;
  var enteringdata = false;
  var cursorcoords = [0,0];
  var session = 0;
  var drawing = false;
  var erasing = false;
  var markerson = false;
  var lineon = false;
  var linelastcoord = [0,0];
  var observing = {status:false, id:0};
  var linedistance = 0;
  var mousedown = false;
  var objects = [];
  var currentid = 0;
  var color = "#634FF1";
  var cursors = [];
  var userlocation = "";
  var places = [];
  var place_ids = [];
  var room = "";

  // ---------------------------------------------------------------
  // Supabase data helpers
  // The original app addressed the Firebase Realtime Database with
  // db.ref("rooms/<room>/..."). Each of those paths is a table here.
  // ---------------------------------------------------------------

  function logResult(res) {
    if (res && res.error) console.error("[supabase]", res.error.message || res.error);
    return res;
  }

  function normalizeUser(u) {
    if (!u) return null;
    var meta = u.user_metadata || {};
    return {
      uid: u.id,
      email: u.email || "",
      displayName: meta.full_name || meta.name || (u.email ? u.email.split("@")[0] : "User"),
      photoURL: meta.avatar_url || meta.picture || null
    };
  }

  function shapeFromRow(row) {
    if (!row) return row;
    row.user = row.user_id;             // the rest of the app speaks "user"
    row.desc = row.description || "";   // ...and "desc"
    return row;
  }

  // crypto.randomUUID needs a secure context; fall back when served over plain http on a LAN IP
  function uuidv4() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c){
      var r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Per-object write queue.
  // Firebase ordered every .set()/.push() on one socket; PostgREST requests can
  // overtake each other, so writes for the same object are chained explicitly.
  // This guarantees the INSERT lands before the first coordinate append.
  var objectWrites = {};

  function queueObjectWrite(id, fn) {
    var prev = objectWrites[id] || Promise.resolve();
    var next = prev.then(fn).catch(function(e){
      console.error("[supabase]", e && e.message ? e.message : e);
    });
    objectWrites[id] = next;
    return next;
  }

  function createObject(data) {
    var id = uuidv4();
    var row = Object.assign({ id: id, room_id: room }, data);
    if (row.user !== undefined) { row.user_id = row.user; delete row.user; }
    if (row.desc !== undefined) { row.description = row.desc; delete row.desc; }
    queueObjectWrite(id, function(){
      return supabaseClient.from("room_objects").insert(row).then(logResult);
    });
    return id;
  }

  function updateObject(id, data) {
    var patch = Object.assign({}, data);
    if (patch.desc !== undefined) { patch.description = patch.desc; delete patch.desc; }
    if (patch.user !== undefined) { patch.user_id = patch.user; delete patch.user; }
    queueObjectWrite(id, function(){
      return supabaseClient.from("room_objects").update(patch).eq("id", id).then(logResult);
    });
  }

  function deleteObject(id) {
    if (!id) return;
    queueObjectWrite(id, function(){
      return supabaseClient.from("room_objects").delete().eq("id", id).then(logResult);
    });
  }

  // Coordinates are buffered and sent as one batch (~8 requests/s max) instead of
  // one request per mousemove event, which keeps the write queue from backing up.
  var coordBuffers = {};  // object id -> pending [[lat, lng], ...]
  var coordTimers = {};   // object id -> flush timer

  function appendCoord(id, lat, lng) {
    if (!id) return;
    var buf = coordBuffers[id] || (coordBuffers[id] = []);
    buf.push([lat, lng]);
    if (!coordTimers[id]) {
      coordTimers[id] = window.setTimeout(function(){ flushCoords(id); }, 120);
    }
  }

  var coordRpcWarned = false;

  function flushCoords(id) {
    if (coordTimers[id]) { window.clearTimeout(coordTimers[id]); coordTimers[id] = null; }
    var buf = coordBuffers[id] || [];
    coordBuffers[id] = [];
    if (!buf.length) return;
    var payload = buf.map(function(p){ return { set: p }; });
    queueObjectWrite(id, function(){
      return supabaseClient.rpc("append_coords", { p_object_id: id, p_coords: payload }).then(function(res){
        // A missing function or an RLS rejection here means strokes are drawn but never
        // saved. Say that out loud instead of printing a generic error nobody looks at.
        if (res && res.error && !coordRpcWarned) {
          coordRpcWarned = true;
          console.error("[supabase] append_coords failed, drawn paths will not persist. " +
            "If the message says \"Could not find the function\", re-run supabase/schema.sql " +
            "in the Supabase SQL editor —", res.error.message || res.error);
        }
        return res;
      });
    });
  }

  function updateUser(data) {
    if (!currentUser || !room) return;
    var row = Object.assign({ room_id: room, user_id: currentUser.uid }, data);
    supabaseClient.from("room_users").upsert(row, { onConflict: "room_id,user_id" }).then(logResult);
  }

  function updateRoom(data) {
    if (!room) return;
    supabaseClient.from("rooms").update(data).eq("id", room).then(logResult);
  }

  // Cursor / viewport updates are throttled to ~8 writes per second instead of one per mousemove
  var lastCursorSent = 0;
  var cursorSendTimer = null;

  function sendCursor(lat, lng) {
    var payload = {
      view_lat: map.getBounds().getCenter().lat,
      view_lng: map.getBounds().getCenter().lng
    };
    if (!dragging) {
      payload.lat = lat;
      payload.lng = lng;
    }
    var send = function(){
      lastCursorSent = Date.now();
      updateUser(payload);
    };
    if (Date.now() - lastCursorSent > 120) {
      send();
    } else if (!cursorSendTimer) {
      cursorSendTimer = window.setTimeout(function(){ cursorSendTimer = null; send(); }, 120);
    }
  }

  // Available cursor colors
  var colors = ["#EC1D43", "#EC811D", "#ECBE1D", "#B6EC1D", "#1DA2EC", "#781DEC", "#CF1DEC", "#222222"];

  // Get URL params
  var params = new URLSearchParams(window.location.search);

  // Check if URL has the file GET parameter, use it to set the room. Could rewrite URL to be more fancy
  var ROOM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (params.has('file') && ROOM_ID_RE.test(params.get('file'))) {
    room = params.get('file');
    $("#share-url").val(window.location.href);
  } else if (params.has('file')) {
    // Old Firebase keys (and anything malformed) aren't valid room ids any more
    params.delete('file');
    console.error("[supabase] Ignoring invalid room id in the URL");
  }

  // Resolve the Supabase session first. This also finishes the email confirmation
  // link that brings people back to this page (?code=...).
  async function boot() {
    var res = await supabaseClient.auth.getSession();
    currentUser = normalizeUser(res.data && res.data.session && res.data.session.user);

    supabaseClient.auth.onAuthStateChange(function(event, authSession){
      currentUser = normalizeUser(authSession && authSession.user);
      if (event === "SIGNED_IN" && params.has("file") && !dataLoaded) {
        // Deferred so no API call happens inside the auth callback
        window.setTimeout(checkData, 0);
      }
    });

    // Drop the auth ?code= from the address bar once it has been exchanged
    // (used by email confirmation links, which come back to this page)
    if (params.has("code")) {
      params.delete("code");
      window.history.replaceState({}, document.title, window.location.pathname + (params.toString() ? "?" + params.toString() : ""));
      $("#share-url").val(window.location.href);
    }

    if (currentUser && params.has("file")) {
      checkData();
    } else {
      // Signed in but no map selected -> offer to create one, otherwise show the auth form
      if (currentUser) showSignedInState();
      else showSignInState();
      // Show popup & overlay
      $("#overlay").addClass("signin");
      $("#popup").addClass("signin");
    }

    // Surface auth errors (expired confirmation link, misconfigured project) instead of silently bouncing back
    var authError = params.get("error_description") || params.get("error");
    if (!currentUser && authError) {
      showAuthMessage(authError, true);
      params.delete("error");
      params.delete("error_description");
      window.history.replaceState({}, document.title, window.location.pathname + (params.toString() ? "?" + params.toString() : ""));
    }
  }
  boot();

  function initMap() {
    // Makimum bounds for zooming and panning
    map.setMaxBounds([[84.67351256610522, -174.0234375], [-58.995311187950925, 223.2421875]]);

    // Base tiles: Mapbox Streets raster tiles.
    //
    // Two options are not optional here:
    //  - id: Leaflet only substitutes {x}/{y}/{z}/{s}; {id} and {accessToken} come from
    //    the options object. Miss it and every request goes out as .../styles/v1/%7Bid%7D/...
    //    which returns 404, leaving a blank map.
    //  - tileSize 512 + zoomOffset -1: a 512 tile covers twice the ground of a normal
    //    256 tile at the same z, so Leaflet has to ask for z-1. Using either one alone
    //    shifts the whole map by one zoom level.
    // @2x turns those 512 CSS px into a 1024px image, which stays sharp on retina;
    // drop the @2x to cut tile weight from ~240KB to ~80KB if bandwidth matters more.
    L.tileLayer('https://api.mapbox.com/styles/v1/{id}/tiles/512/{z}/{x}/{y}@2x?access_token=your-apikey', {
      id: "mapbox/streets-v12",
      tileSize: 512,
      zoomOffset: -1,
      maxZoom: 22,
      zoomControl: true,
      minZoom: 3,
      noWrap: true,
      attribution: '&copy; <a href="https://www.mapbox.com/about/maps/" target="_blank">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
    }).on("tileerror", function(e){
      // Surfaces an expired token / quota problem instead of a silent grey map
      console.error("[mapbox] tile failed:", e.tile && e.tile.src);
    }).addTo(map);

    // Hide the default zoom control. I want a custom one!
    map.removeControl(map.zoomControl);

    // No idea why but Leaflet seems to place default markers on startup...
    $("img[src='https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png']").remove();
  }

  // Hints for drawing lines or polygons
  var followcursor = L.marker([0, 0], {pane: "overlayPane", interactive:false}).addTo(map);
  followcursor.setOpacity(0);
  var tooltip = followcursor.bindTooltip("", { permanent: true, offset:[5,25], sticky: true, className: "hints", direction:"right"}).addTo(map);
  followcursor.closeTooltip();

  // Show live location
  function liveLocation() {
    if (navigator.geolocation) {
      // Get initial location
      navigator.geolocation.getCurrentPosition(function(position){
        var icon = L.icon({
          iconUrl: 'assets/liveLocation.svg',
          iconSize:     [24, 24],
          iconAnchor:   [12, 12],
        });
        // Create a marker to show the user location
        userlocation = L.marker([position.coords.latitude, position.coords.longitude], {icon:icon, pane: "overlayPane"});
        userlocation.addTo(map);
      });
    }
  }

  function targetLiveLocation() {
    stopObserving();

    // Check if user has geolocation enabled
    if (navigator.geolocation) {
      if (userlocation != "") {
        // If current location is already set, fly there
        navigator.geolocation.getCurrentPosition(function(position){
          userlocation.setLatLng([position.coords.latitude, position.coords.longitude]);

          // Flies to the location (more fancy)
          map.flyTo(userlocation.getLatLng(), 18)
        });
      } else {
        // If the location is unknown, set it and fly there
        liveLocation();
        targetLiveLocation();
      }
    }
  }

  // Tooltips for UI elements
  function showTooltip() {
    if ($(this).attr("id") == "cursor-tool") {
      $(this).append('<div id="tooltip">Move (V)</div>');
    } else if ($(this).attr("id") == "pen-tool") {
      $(this).append('<div id="tooltip">Pencil (P)</div>');
    } else if ($(this).attr("id") == "eraser-tool") {
      $(this).append('<div id="tooltip">Eraser (E)</div>');
    } else if ($(this).attr("id") == "marker-tool") {
      $(this).append('<div id="tooltip">Marker (M)</div>');
    } else if ($(this).attr("id") == "area-tool") {
      $(this).append('<div id="tooltip">Area (A)</div>');
    } else if ($(this).attr("id") == "path-tool") {
      $(this).append('<div id="tooltip">Line (L)</div>');
    }
  }
  function hideTooltip() {
    $(this).find("#tooltip").remove();
  }

  // Reset tools (when switching tools)
  function resetTools() {
    drawing = false;
    erasing = false;
    markerson = false;
    lineon = false;
    map.pm.disableDraw();
    map.pm.disableGlobalRemovalMode();
    map.pm.disableGlobalDragMode();
  }

  // Enable cursor tool (default)
  function cursorTool() {
    resetTools();
    map.dragging.enable();
    $(".tool-active").removeClass("tool-active");
    $("#cursor-tool").addClass("tool-active");
  }

  // Enable pen tool
  function penTool() {
    resetTools();
    drawing = true;
    map.dragging.disable();
    $(".tool-active").removeClass("tool-active");
    $("#pen-tool").addClass("tool-active");
    showAnnotations();
  }

  // Enable eraser tool
  function eraserTool() {
    resetTools();
    erasing = true;
    $(".tool-active").removeClass("tool-active");
    $("#eraser-tool").addClass("tool-active");
    map.pm.enableGlobalRemovalMode();
    showAnnotations();
  }

  // Enable marker tool
  function markerTool() {
    resetTools();
    markerson = true;
    $(".tool-active").removeClass("tool-active");
    $("#marker-tool").addClass("tool-active");
    showAnnotations();
  }

  // Enable area tool
  function areaTool() {
    resetTools();
    $(".tool-active").removeClass("tool-active");
    $("#area-tool").addClass("tool-active");

    // Start creating an area
    map.pm.setGlobalOptions({ pinning: true, snappable: true });
    map.pm.setPathOptions({
      color: color,
      fillColor: color,
      fillOpacity: 0.4,
    });
    map.pm.enableDraw('Polygon', {
      tooltips: false,
      snappable: true,
      templineStyle: {color: color},
      hintlineStyle: {color: color, dashArray: [5, 5]},
      pmIgnore: false
    });
    showAnnotations();
  }

  // Enable line tool
  function pathTool() {
    resetTools();
    $(".tool-active").removeClass("tool-active");
    $("#path-tool").addClass("tool-active");

    // Start creating a line
    map.pm.setGlobalOptions({ pinning: true, snappable: true });
    map.pm.setPathOptions({
      color: color,
      fillColor: color,
      fillOpacity: 0.4,
    });
    map.pm.enableDraw('Line', {
      tooltips: false,
      snappable: true,
      templineStyle: {color: color},
      hintlineStyle: {color: color, dashArray: [5, 5]},
      pmIgnore: false,
      finishOn: 'dblclick',
    });
    showAnnotations();
  }

  // Show/hide color picker
  function toggleColor() {
    $("#color-list").toggleClass("color-enabled");
  }

  // Switch color (color picker)
  function switchColor(e) {
    e.stopPropagation();
    color = $(this).attr("data-color");
    $("#inner-color").css({background:color});
    toggleColor();
  }

  // Sanitizing input strings
  function sanitize(string) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        "/": '&#x2F;',
    };
    const reg = /[&<>"'/]/ig;
    return string.replace(reg, (match)=>(map[match]));
  }

  // Perform a search query. No autocomplete due to API rules :(
  function search() {
    $.get('https://nominatim.openstreetmap.org/search?q='+sanitize($("#search-box input").val())+'&format=json', function(data) {
      // Navigate to the first result of the search query
      map.panTo(new L.LatLng(data[0].lat, data[0].lon));
    })
  }

  // Find nearby
  // Nominatim's documented "amenity-only" search: bounded=1 plus a viewbox and the
  // category as a [phrase] in q. Three things used to keep these buttons dead:
  //   - exclude_place_ids was sent as a JSON array ("[]") instead of a comma separated
  //     list, which makes Nominatim reject the whole request;
  //   - the category went into an amenity= filter, which is part of the structured
  //     query and only works together with a place name/city;
  //   - the markers' tooltip was interactive:false, so Save/Remove were unclickable.
  var nearbyBusy = false;

  function findNearby() {
    if (checkAuth() == false || nearbyBusy) return;

    var button = $(this);
    var locationtype = button.attr("data-type");
    var markercolor = button.attr("data-color");
    if (!locationtype) return;

    var bounds = map.getBounds();
    var viewbox = [
      bounds.getNorthWest().lng, bounds.getNorthWest().lat,
      bounds.getSouthEast().lng, bounds.getSouthEast().lat
    ].join(",");

    var params = { format: "geocodejson", viewbox: viewbox, bounded: 1, limit: 20 };
    // Only send the exclusion list when there is something to exclude
    if (place_ids.length > 0) params.exclude_place_ids = place_ids.join(",");

    nearbyBusy = true;
    button.addClass("nearby-loading");

    function finish() {
      nearbyBusy = false;
      button.removeClass("nearby-loading");
    }

    $.ajax({
      url: "https://nominatim.openstreetmap.org/search",
      dataType: "json",
      data: $.extend({ q: "[" + locationtype + "]" }, params)
    }).done(function(data) {
      var features = (data && data.features) || [];
      if (features.length > 0) {
        renderNearbyPlaces(features, locationtype, markercolor);
        finish();
        return;
      }

      // Categories without a special phrase: retry as a structured amenity query.
      // Spaced out to stay inside Nominatim's 1 request/second policy.
      window.setTimeout(function() {
        $.ajax({
          url: "https://nominatim.openstreetmap.org/search",
          dataType: "json",
          data: $.extend({ amenity: locationtype }, params)
        }).done(function(fallback) {
          renderNearbyPlaces((fallback && fallback.features) || [], locationtype, markercolor);
        }).fail(function(xhr) {
          console.error("[nearby] lookup failed:", xhr.status, xhr.statusText);
        }).always(finish);
      }, 1100);
    }).fail(function(xhr) {
      console.error("[nearby] lookup failed:", xhr.status, xhr.statusText);
      finish();
    });
  }

  // Draw the POIs returned by Nominatim as removable preview markers
  function renderNearbyPlaces(features, locationtype, markercolor) {
    var user = checkAuth();
    if (user == false) return;

    var marker_icon = L.icon({
      iconUrl: "assets/" + locationtype + "-marker.svg",
      iconSize:     [30, 30],
      iconAnchor:   [15, 30],
      shadowAnchor: [4, 62],
      popupAnchor:  [-3, -76]
    });

    var added = 0;
    features.forEach(function(place) {
      var coordinates = place && place.geometry && place.geometry.coordinates;
      var geocoding = (place && place.properties && place.properties.geocoding) || {};
      if (!coordinates || coordinates.length < 2 || !geocoding.place_id) return;
      // Skip anything already on the map: the API does not always honour the exclusion list
      if (places.find(function(existing){ return existing.place_id == geocoding.place_id; })) return;

      var lat = coordinates[1];
      var lng = coordinates[0];
      var name = geocoding.name || geocoding.label || "Unnamed place";

      var marker = L.marker([lat, lng], {icon: marker_icon, pane: "overlayPane", interactive: true}).addTo(map);

      // interactive:true so the Save/Remove buttons inside the tooltip can be clicked
      marker.bindTooltip('<h1>'+name+'</h1><div class="shape-data"><h3><img src="assets/marker-small-icon.svg">'+lat.toFixed(5)+', '+lng.toFixed(5)+'</h3></div><br><div id="buttons2"><button class="cancel-button-place" data-id="'+geocoding.place_id+'">Remove</button><button class="save-button-place" data-id="'+geocoding.place_id+'">Save</button></div><div class="arrow-down"></div>', {permanent: false, direction:"top", interactive:true, bubblingMouseEvents:false, className:"create-shape-flow", offset: L.point({x: 0, y: -35})});

      places.push({id: "", place_id: geocoding.place_id, user: user.uid, name: name, desc: "", lat: lat, lng: lng, trigger: marker, completed: true, marker: marker, m_type: locationtype, type: "marker", session: session, color: markercolor});
      place_ids.push(geocoding.place_id);
      added++;
    });

    if (added == 0) {
      console.log("[nearby] no " + locationtype + " found in this view");
    }
  }

  // Save nearby location (share with other users, they all will see it)
  function saveNearby() {
    var user = checkAuth();
    if (checkAuth() != false) {
      var inst = places.find(x => x.place_id == $(this).attr("data-id"));
      // Ignore unknown places and double clicks on an already saved one
      if (!inst || inst.id) return;
      currentid = createObject({
        color: inst.color,
        place_id: inst.place_id,
        lat: inst.lat,
        lng: inst.lng,
        user: user.uid,
        type: "marker",
        m_type: inst.m_type,
        session: session,
        name: inst.name,
        desc: ""
      });
      var key = currentid;
      inst.id = currentid;
      objects.push(inst);

      // Create a popup with information about the place
      inst.marker.bindTooltip('<h1>'+inst.name+'</h1><div class="shape-data"><h3><img src="assets/marker-small-icon.svg">'+inst.lat.toFixed(5)+', '+inst.lng.toFixed(5)+'</h3></div><br><div class="arrow-down"></div>', {permanent: false, direction:"top", interactive:false, bubblingMouseEvents:false, className:"create-shape-flow", offset: L.point({x: 0, y: -35})});
    }
  }

  // Remove nearby location
  function cancelNearby() {
    var placeId = $(this).attr("data-id");
    var inst = places.find(x => x.place_id == placeId);
    if (!inst) return;
    if (inst.marker) inst.marker.remove();
    // Compare against the place id: inst.id is only set once the place has been saved
    places = $.grep(places, function(e){
         return e.place_id != inst.place_id;
    });
    place_ids = $.grep(place_ids, function(e){
         return e != inst.place_id;
    });
  }

  // Enable observation mode
  function observationMode() {
    var user = checkAuth();
    if (checkAuth() != false) {
      var otheruser = $(this).attr("data-id");
      if (otheruser != user.uid) {
        if (observing.id == otheruser) {
          // When clicking on the avatar of the current user you're observing, stop observing them
          stopObserving();
        } else {
          // Start observing the selected user
          observing.status = true;
          observing.id = otheruser;

          // Show that observation mode is enabled
          $("#outline").css({"border": "6px solid "+cursors.find(x => x.id === otheruser).color});
          $("#observing-name").html("Observing "+cursors.find(x => x.id === otheruser).name);
          $("#observing-name").css({"background": cursors.find(x => x.id === otheruser).color});
          $("#outline").addClass("observing");
        }
      }
    }
  }

  // Disable observation mode
  function stopObserving() {
    observing.status = false;
    $("#outline").css({"border": "none"});
    $("#outline").removeClass("observing");
  }

  // Save marker/line/area data
  function saveForm(e) {
    var user = checkAuth();
    if (checkAuth() != false) {
      enteringdata = false;
      var inst = objects.filter(function(result){
        return result.id === currentid && result.user === user.uid;
      })[0];

      // Get input values for the name and description and sanitize them
      inst.name = sanitize($("#shape-name").val());
      inst.desc = sanitize($("#shape-desc").val());
      inst.completed = true;

      // Remove existing popup (for inputting data)
      inst.trigger.unbindTooltip();
      if (inst.type == "area") {
        // Create a popup showing info about the area
        inst.trigger.bindTooltip('<h1>'+inst.name+'</h1><h2>'+inst.desc+'</h2><div class="shape-data"><h3><img src="assets/area-icon.svg">'+inst.area+' km&sup2;</h3></div><div class="shape-data"><h3><img src="assets/perimeter-icon.svg">'+inst.distance+' km</h3></div><div class="arrow-down"></div>', {permanent: false, direction:"top", interactive:false, bubblingMouseEvents:false, className:"create-shape-flow", offset: L.point({x: -15, y: 18})});
        updateObject(currentid, {
          area:inst.area,
          distance: inst.distance,
          name: inst.name,
          desc: inst.desc,
          completed: true
        })
      } else if (inst.type == "line") {
        // Create a popup showing info about the line
        inst.trigger.bindTooltip('<h1>'+inst.name+'</h1><h2>'+inst.desc+'</h2><div class="shape-data"><h3><img src="assets/distance-icon.svg">'+inst.distance+' km</h3></div><div class="arrow-down"></div>', {permanent: false, direction:"top", interactive:false, bubblingMouseEvents:false, className:"create-shape-flow", offset: L.point({x: -15, y: 18})});
        updateObject(currentid, {
          distance: inst.distance,
          name: inst.name,
          desc: inst.desc,
          completed: true
        })
      } else if (inst.type == "marker") {
        // Create a popup showing info about the marker
        inst.trigger.bindTooltip('<h1>'+inst.name+'</h1><h2>'+inst.desc+'</h2><div class="shape-data"><h3><img src="assets/marker-small-icon.svg">'+inst.lat.toFixed(5)+', '+inst.lng.toFixed(5)+'</h3></div><div class="arrow-down"></div>', {permanent: false, direction:"top", interactive:false, bubblingMouseEvents:false, className:"create-shape-flow", offset: L.point({x: 0, y: -35})});
        updateObject(currentid, {
          name: inst.name,
          desc: inst.desc,
          completed: true
        })
      }

      // Render the shape in the sidebar list and focus it
      renderObjectLayer(inst);
      $(".annotation-item[data-id='"+inst.id+"']").find(".annotation-name span").addClass("annotation-focus");

      // Automatically open the new popup with data about the shape
      window.setTimeout(function(){
        inst.trigger.openTooltip();
      }, 200)
    }
  }

  // Don't save marker/line/area data (doesn't delete them, just reverts to defaults)
  function cancelForm() {
    var user = checkAuth();
    if (checkAuth() != false) {
      enteringdata = false;
      var inst = objects.filter(function(result){
        return result.id === currentid && result.user === user.uid;
      })[0];

      // Delete existing popup (for inputting data)
      inst.trigger.unbindTooltip();
      inst.completed = true;
      if (inst.type == "area") {
        // Create a popup showing info about the area
        inst.trigger.bindTooltip('<h1>'+inst.name+'</h1><h2>'+inst.desc+'</h2><div class="shape-data"><h3><img src="assets/area-icon.svg">'+inst.area+' km&sup2;</h3></div><div class="shape-data"><h3><img src="assets/perimeter-icon.svg">'+inst.distance+' km</h3></div><div class="arrow-down"></div>', {permanent: false, direction:"top", interactive:false, bubblingMouseEvents:false, className:"create-shape-flow", offset: L.point({x: -15, y: 18})});
        updateObject(currentid, {
          area:inst.area,
          distance: inst.distance,
          name: inst.name,
          desc: inst.desc,
          completed: true
        })
      } else if (inst.type == "line") {
        // Create a popup showing info about the line
        inst.trigger.bindTooltip('<h1>'+inst.name+'</h1><h2>'+inst.desc+'</h2><div class="shape-data"><h3><img src="assets/distance-icon.svg">'+inst.distance+' km</h3></div><div class="arrow-down"></div>', {permanent: false, direction:"top", interactive:false, bubblingMouseEvents:false, className:"create-shape-flow", offset: L.point({x: -15, y: 18})});
        updateObject(currentid, {
          distance: inst.distance,
          name: inst.name,
          desc: inst.desc,
          completed: true
        })
      } else if (inst.type == "marker") {
        // Create a popup showing info about the marker
        inst.trigger.bindTooltip('<h1>'+inst.name+'</h1><h2>'+inst.desc+'</h2><div class="shape-data"><h3><img src="assets/marker-small-icon.svg">'+inst.lat.toFixed(5)+', '+inst.lng.toFixed(5)+'</h3></div><div class="arrow-down"></div>', {permanent: false, direction:"top", interactive:false, bubblingMouseEvents:false, className:"create-shape-flow", offset: L.point({x: 0, y: -35})});
        updateObject(currentid, {
          name: inst.name,
          desc: inst.desc,
          completed: true
        })
      }

      // Render shape in the sidebar list and focus it
      renderObjectLayer(inst);
      $(".annotation-item[data-id='"+inst.id+"']").find(".annotation-name span").addClass("annotation-focus");

      // Automatically open the new popup with data about the shape
      window.setTimeout(function(){
        inst.trigger.openTooltip();
      }, 200)
    }
  }

  // Start drawing lines/areas
  map.on('pm:drawstart', ({ workingLayer }) => {
    var user = checkAuth();
    if (checkAuth() != false) {
      // Show hints for drawing lines/areas
      followcursor.openTooltip();
      followcursor.setTooltipContent("Click to place first vertex");

      // Detect when a vertex is added to a line or area
      workingLayer.on('pm:vertexadded', e => {
        if (e.shape == "Polygon") {
          // Update hints
          followcursor.setTooltipContent("Click on first vertex to finish");
          linelastcoord = e.layer._latlngs[e.layer._latlngs.length-1];
          if (e.layer._latlngs.length == 1) {
            // If this is the first vertex, get a key and add the new shape in the database
            currentid = createObject({
              color: color,
              initlat: e.layer._latlngs[0].lat,
              initlng: e.layer._latlngs[0].lng,
              user: user.uid,
              type: "area",
              session: session,
              name: "Area",
              desc: "",
              distance: 0,
              area: 0,
              completed: false
            });
            appendCoord(currentid, linelastcoord.lat, linelastcoord.lng);
            objects.push({id:currentid, local:true, color:color, user:user.uid, name:"Area", desc:"", trigger:"", distance:0, area:0, layer:"", type:"area", session:session, completed:false});
          } else {
            // If this is not the first vertex, update the data in the database with the latest coordinates
            appendCoord(currentid, linelastcoord.lat, linelastcoord.lng);
          }
        } else if (e.shape == "Line") {
          lineon = true;
          linedistance = 0;
          linelastcoord = e.layer._latlngs[e.layer._latlngs.length-1];
          if (e.layer._latlngs.length == 1) {
            // If this is the first vertex, get a key and add the new shape in the database
            currentid = createObject({
              color: color,
              initlat: e.layer._latlngs[0].lat,
              initlng: e.layer._latlngs[0].lng,
              user: user.uid,
              type: "line",
              session: session,
              name: "Line",
              desc: "",
              distance: 0,
              completed: false
            });
            appendCoord(currentid, linelastcoord.lat, linelastcoord.lng);
            objects.push({id:currentid, local:true, color:color, user:user.uid, name:"Line", desc:"", trigger:"", distance:0, layer:"", type:"line", session:session, completed:false});
          } else {
            // If this is not the first vertex, update hints to show total distance drawn
            e.layer._latlngs.forEach(function(coordinate, index){
              if (index != 0) {
                linedistance += e.layer._latlngs[index-1].distanceTo(coordinate);
              }
            });
            followcursor.setTooltipContent((linedistance/1000)+"km | Double click to finish");

            // Save new vertext in the database
            appendCoord(currentid, linelastcoord.lat, linelastcoord.lng);
          }
        }
      });
    }
  });

  // Stop drawing lines / polygons
  map.on('pm:drawend', e => {
    lineon = false;
    followcursor.closeTooltip();
    cursorTool();
  });

  // Add tooltip to lines and polygons
  map.on('pm:create', e => {
    var user = checkAuth();
    if (checkAuth() != false) {
      enteringdata = true;
      var inst = objects.filter(function(result){return result.id === currentid && result.user === user.uid;})[0];

      // Calculate total distance / perimeter
      inst.distance = parseFloat(turf.length(e.layer.toGeoJSON()).toFixed(2));
      inst.layer = e.layer;
      if (inst.type == "area") {
        // Calculate area
        inst.area = parseFloat((turf.area(e.layer.toGeoJSON())*0.000001).toFixed(2));

        // Save all the area coordinates
        var temppath = [];
        Object.values(e.layer.getLatLngs()[0]).forEach(function(a){
          temppath.push([Object.values(a)[0], Object.values(a)[1]]);
        })

        // Update the data in the database
        updateObject(currentid, {
          path:temppath,
          area:inst.area
        })
      } else if (inst.type == "line") {
        // Save all the line coordinates
        var temppath = [];
        Object.values(e.layer.getLatLngs()).forEach(function(a){
          temppath.push([Object.values(a)[0], Object.values(a)[1]]);
        })

        // Update the data in the database
        updateObject(currentid, {
          path:temppath
        })
      }

      // Create a marker so it can trigger a popup when clicking on a line, or area
      var centermarker = L.marker(e.layer.getBounds().getCenter(), {zIndexOffset:9999, interactive:false, pane:"overlayPane"});

      // Create a popup so users can name and give a description to the shape
      centermarker.bindTooltip('<label for="shape-name">Name</label><input value="'+inst.name+'" id="shape-name" name="shape-name" /><label for="shape-desc">Description</label><textarea id="shape-desc" name="description"></textarea><br><div id="buttons"><button class="cancel-button">Cancel</button><button class="save-button">Save</button></div><div class="arrow-down"></div>', {permanent: true, direction:"top", interactive:true, bubblingMouseEvents:false, className:"create-shape-flow create-form", offset: L.point({x: -15, y: 18})});

      // The marker is supposed to be hidden, it's just for placing the tooltip on the map and triggering it
      centermarker.setOpacity(0);
      centermarker.addTo(map);
      centermarker.openTooltip();

      // Automatically select the name so it's faster to edit
      $("#shape-name").focus();
      $("#shape-name").select();

      inst.trigger = centermarker;

      // Detect when clicking on the shape
      e.layer.on("click", function(e){
        if (!erasing) {
          // Set the popup to the mouse coordinates and open it
          centermarker.setLatLng(cursorcoords);
          centermarker.openTooltip();
        } else {
          // If erasing, delete the shape
          inst.trigger.remove();
          e.layer.remove();
          deleteObject(inst.id);
          objects = $.grep(objects, function(e){
               return e.id != inst.id;
          });
          $(".annotation-item[data-id='"+inst.id+"']").remove();
        }
      });

      // Detect when closing the popup (e.g. when clicking outside of it)
      centermarker.on('tooltipclose', function(e){
        if (enteringdata) {
          // If closing the popup before a name and description has been set, revert to defaults
          cancelForm();
        }

        // De-select the object from the sidebar list
        $(".annotation-item[data-id="+inst.id+"]").find(".annotation-name span").removeClass("annotation-focus");
      });
    }
  });

  // Start free drawing
  function startDrawing(lat,lng,user) {
    var line = L.polyline([[lat,lng]], {color: color});

    // Create a new key for the line object, and set initial data in the database
    currentid = createObject({
      color: color,
      initlat: lat,
      initlng: lng,
      user: user.uid,
      type: "draw",
      session: session,
      completed: true
    });
    appendCoord(currentid, lat, lng);

    // Save an object with all the defaults
    var inst = {id:currentid, user:user.uid, line:line, session:session, local:true, completed:true, type:"draw"};
    objects.push(inst);
    line.addTo(map);

    // Event handling for this stroke only. Binding to every object again on each new
    // stroke stacked duplicate handlers, so one eraser click fired N deletes.
    line.on("click", function(event){
      if (erasing) {
        line.remove();
        deleteObject(inst.id);
        objects = $.grep(objects, function(e){
             return e.id != inst.id;
        });
        $(".annotation-item[data-id='"+inst.id+"']").remove();
      }
    });
    line.on("mouseover", function(event){
      if (erasing) {
        line.setStyle({opacity: .3});
      }
    });
    line.on("mouseout", function(event){
      line.setStyle({opacity: 1});
    });
  }

  // Create a new marker
  function createMarker(lat, lng, user) {
    if (markerson) {
      // Go back to cursor tool after creating a marker
      cursorTool();

      // Set custom marker icon
      var marker_icon = L.divIcon({
        html: '<svg width="30" height="30" viewBox="0 0 46 46" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M23 44.0833C23 44.0833 40.25 32.5833 40.25 19.1666C40.25 14.5916 38.4326 10.204 35.1976 6.96903C31.9626 3.73403 27.575 1.91663 23 1.91663C18.425 1.91663 14.0374 3.73403 10.8024 6.96903C7.56741 10.204 5.75 14.5916 5.75 19.1666C5.75 32.5833 23 44.0833 23 44.0833ZM28.75 19.1666C28.75 22.3423 26.1756 24.9166 23 24.9166C19.8244 24.9166 17.25 22.3423 17.25 19.1666C17.25 15.991 19.8244 13.4166 23 13.4166C26.1756 13.4166 28.75 15.991 28.75 19.1666Z" fill="'+color+'"/>/svg>',
        iconSize:     [30, 30], // size of the icon
        iconAnchor:   [15, 30], // point of the icon which will correspond to marker's location
        shadowAnchor: [4, 62],  // the same for the shadow
        popupAnchor:  [-3, -76] // point from which the popup should open relative to the iconAnchor
      });
      var marker = L.marker([lat, lng], {icon:marker_icon, direction:"top", interactive:true, pane:"overlayPane"});

      // Create a popup to set the name and description of the marker
      marker.bindTooltip('<label for="shape-name">Name</label><input value="Marker" id="shape-name" name="shape-name" /><label for="shape-desc">Description</label><textarea id="shape-desc" name="description"></textarea><br><div id="buttons"><button class="cancel-button">Cancel</button><button class="save-button">Save</button></div><div class="arrow-down"></div>', {permanent: true, direction:"top", interactive:false, bubblingMouseEvents:false, className:"create-shape-flow create-form", offset: L.point({x: 0, y: -35})});
      marker.addTo(map);
      marker.openTooltip();

      // Create a new key for the marker, and add it to the database
      currentid = createObject({
        color: color,
        lat: lat,
        lng: lng,
        user: user.uid,
        type: "marker",
        m_type: "none",
        session: session,
        name: "Marker",
        desc: ""
      });
      var key = currentid;
      objects.push({id:currentid, user:user.uid, color:color, name:"Marker", m_type:"none",  desc:"", lat:lat, lng:lng, marker:marker, trigger:marker, session:session, completed:true, type:"marker"});

      // Detect when the tooltip is closed
      marker.on('tooltipclose', function(e){
        if (enteringdata) {
          // If closing the tooltip but the name and description haven't been set yet, revert to defaults
          cancelForm();
        } else {
          // De-select object from sidebar
          $(".annotation-item[data-id="+key+"]").find(".annotation-name span").removeClass("annotation-focus");
        }
      });

      // Detect when the marker is clicked
      marker.on('click', function(e){
        if (!erasing) {
          // Open tooltip when the marker is clicked
          marker.openTooltip();
        } else {
          // If erasing, delete the marker
          marker.remove();
          deleteObject(key);
          objects = $.grep(objects, function(e){
               return e.id != key;
          });
        }
      })
    }
  }

  // Map events
  map.addEventListener('mousedown', (event) => {
    var user = checkAuth();
    if (checkAuth() != false) {
      mousedown = true;
      // Get mouse coordinates and save them locally
      let lat = Math.round(event.latlng.lat * 100000) / 100000;
      let lng = Math.round(event.latlng.lng * 100000) / 100000;
      cursorcoords = [lat,lng];
      if (drawing) {
        // If the pencil tool is enabled, start drawing
        startDrawing(lat,lng,user);
      }
    }
  });
  map.addEventListener('click', (event) => {
    var user = checkAuth();
    if (checkAuth() != false) {
      // Get mouse coordinates and save them locally
      let lat = Math.round(event.latlng.lat * 100000) / 100000;
      let lng = Math.round(event.latlng.lng * 100000) / 100000;
      cursorcoords = [lat,lng];
      // Create a marker if the marker tool is enabled
      createMarker(lat,lng,user);
      // The pencil tool starts a stroke on mousedown; running startDrawing() here as
      // well left a stray one-point object behind after every stroke.
    }
  });
  map.addEventListener('mouseup', (event) => {
    mousedown = false;
  })
  map.addEventListener('mousemove', (event) => {
    var user = checkAuth();
    if (checkAuth() != false) {
      // Get cursor coordinates and save them locally
      let lat = Math.round(event.latlng.lat * 100000) / 100000;
      let lng = Math.round(event.latlng.lng * 100000) / 100000;
      cursorcoords = [lat,lng];

      // Make tooltip for line and area hints follow the cursor
      followcursor.setLatLng([lat,lng]);
      if (mousedown && drawing) {
        // If the pencil tool is enabled, draw to the mouse coordinates
        objects.filter(function(result){
          return result.id === currentid && result.user === user.uid;
        })[0].line.addLatLng([lat,lng]);

        // Update drawn path in the database
        appendCoord(currentid, lat, lng);
      }

      // If drawing a line, show the distance of drawn line in the tooltip
      if (lineon) {
        followcursor.setTooltipContent(((linedistance+linelastcoord.distanceTo([lat,lng]))/1000).toFixed(2)+"km | Double click to finish");
      }
      if (typeof lat != undefined && typeof lng != undefined) {
        // Save mouse coordinates for real-time cursors, plus current view for observation mode
        sendCursor(lat, lng);
      }
    }
  });
  map.addEventListener('zoom', (event) => {
    var user = checkAuth();
    if (checkAuth() != false) {
      // Save current view and zoom for observation mode
      updateUser({
          view_lat: map.getBounds().getCenter().lat,
          view_lng: map.getBounds().getCenter().lng,
          zoom: map.getZoom()
      });
      stopObserving();
    }
  });
  map.addEventListener('movestart', (event) => {
    dragging = true;
  });
  map.addEventListener('moveend', (event) => {
    dragging = false;
  });

  // Server code
  function checkAuth() {
      return currentUser == null ? false : currentUser;
  }

  // Email + password authentication
  var authMode = "signin";   // "signin" | "signup"

  function setAuthBusy(busy) {
    $("#auth-submit")
      .prop("disabled", busy)
      .toggleClass("auth-busy", busy)
      .text(busy ? "Please wait..." : (authMode === "signup" ? "Create account" : "Sign in"));
  }

  function showAuthMessage(message, isError) {
    $("#auth-message")
      .text(message || "")
      .toggleClass("auth-error", !!isError)
      .toggleClass("auth-ok", !isError);
  }

  function setAuthMode(mode) {
    authMode = mode === "signup" ? "signup" : "signin";
    $("#auth-name").toggle(authMode === "signup");
    $("#auth-password").attr("autocomplete", authMode === "signup" ? "new-password" : "current-password");
    $("#auth-switch").html(authMode === "signup"
      ? 'Already have an account? <span>Sign in</span>'
      : 'New here? <span>Create an account</span>');
    showAuthMessage("");
    setAuthBusy(false);
  }

  function toggleAuthMode() {
    setAuthMode(authMode === "signup" ? "signin" : "signup");
  }

  function showSignInState() {
    $("#popup").find(".header-text").html("Welcome to Mapus!");
    $("#popup").find(".subheader-text").html("Sign in with your email, or create an account.");
    $("#create-map").hide();
    $("#auth-form").show();
    $("#auth-switch").show();
    setAuthMode("signin");
  }

  function showSignedInState() {
    $("#popup").find(".header-text").html("Create a map");
    $("#popup").find(".subheader-text").html("Maps can be shared with friends to collaborate in real-time.");
    $("#auth-form").hide();
    $("#auth-switch").hide();
    showAuthMessage("");
    $("#create-map").show();
  }

  function authErrorMessage(err) {
    var msg = (err && err.message) || "Something went wrong.";
    if (/invalid login credentials/i.test(msg)) return "Wrong email or password.";
    if (/email not confirmed/i.test(msg)) return "Confirm your email first - check your inbox.";
    if (/user already registered/i.test(msg)) return "That email is already registered. Sign in instead.";
    if (/password should be at least/i.test(msg)) return "Passwords need at least 6 characters.";
    if (/rate limit|too many requests/i.test(msg)) return "Too many attempts, wait a minute and try again.";
    return msg;
  }

  async function submitAuth(e) {
    e.preventDefault();
    // String.prototype.trim, not $.trim: the latter is gone in jQuery 4
    var email = String($("#auth-email").val() || "").trim();
    var password = $("#auth-password").val();
    var displayName = String($("#auth-name").val() || "").trim();

    if (!email) return showAuthMessage("Enter your email address.", true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showAuthMessage("That email address doesn't look right.", true);
    if (!password) return showAuthMessage("Enter a password.", true);
    if (password.length < 6) return showAuthMessage("Passwords need at least 6 characters.", true);
    if (authMode === "signup" && !displayName) return showAuthMessage("Enter a display name.", true);

    setAuthBusy(true);
    showAuthMessage("");

    try {
      if (authMode === "signup") {
        var signUpRes = await supabaseClient.auth.signUp({
          email: email,
          password: password,
          options: {
            data: { full_name: displayName },
            emailRedirectTo: window.location.origin + window.location.pathname + window.location.search
          }
        });
        if (signUpRes.error) throw signUpRes.error;

        if (!signUpRes.data.session) {
          // "Confirm email" is enabled in the project: no session until the link is clicked
          $("#auth-password").val("");
          setAuthMode("signin");
          return showAuthMessage("Almost there - check " + email + " for a confirmation link.", false);
        }
        currentUser = normalizeUser(signUpRes.data.session.user);
      } else {
        var signInRes = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
        if (signInRes.error) throw signInRes.error;
        currentUser = normalizeUser(signInRes.data.user);
      }

      $("#auth-password").val("");

      // Inside a map, load it; otherwise offer to create one
      if (params.has("file")) {
        if (!dataLoaded) checkData();
      } else {
        showSignedInState();
      }
    } catch (err) {
      showAuthMessage(authErrorMessage(err), true);
    } finally {
      setAuthBusy(false);
    }
  }

  // Log out
  function logOut() {
    if (room && currentUser) {
      // Best effort: mark the user offline before tearing the session down
      supabaseClient.from("room_users").update({ active: false })
        .eq("room_id", room).eq("user_id", currentUser.uid).then(logResult);
    }
    supabaseClient.auth.signOut().then(function() {
      // Reload so the next sign-in starts from a clean slate (subscriptions, cached room data)
      window.location.reload();
    });
  }

  // Create a map
  async function createMap() {
    if (checkAuth() == false) return;
    var res = await supabaseClient.from("rooms").insert({
      name: "New map",
      description: "Map description",
      created_by: currentUser.uid
    }).select("id").single();
    if (res.error) return console.error("[supabase]", res.error.message);

    var url = new URL(window.location.href);
    url.searchParams.set("file", res.data.id);
    window.location.replace(url.toString());
  }

  // Collapse/expand objects in the sidebar
  function toggleLayer(e) {
    e.preventDefault();
    e.stopPropagation();
    if ($(this).hasClass("arrow-open")) {
      $(this).removeClass("arrow-open");
      $(this).parent().parent().find(".annotation-details").addClass("annotation-closed");
    } else {
      $(this).addClass("arrow-open");
      $(this).parent().parent().find(".annotation-details").removeClass("annotation-closed");
    }
  }

  // Highlight an object in the sidebar
  function focusLayer() {
    showAnnotations();
    if (!$(this).find(".annotation-name span").hasClass("annotation-focus")) {
      const id = $(this).attr("data-id");
      const inst = objects.find(x => x.id === id);
      if (!inst) return;

      // De-select any previously selected objects
      $(".annotation-focus").removeClass("annotation-focus");

      // Close any opened tooltips
      map.eachLayer(function(layer){
        if (layer.options.pane != "markerPane") {
          layer.closeTooltip();
        }
      });

      // Make layer name bold to show that it has been selected
      $(this).find(".annotation-name span").addClass("annotation-focus");

      // Pan to the annotation and trigger the associated popup
      if (inst.type == "line" || inst.type == "area") {
        map.panTo(inst.trigger.getLatLng());
        $(inst.trigger.getTooltip()._container).removeClass('tooltip-off');
        inst.trigger.openTooltip();
      } else if (inst.type == "marker") {
        map.panTo(inst.marker.getLatLng());
        $(inst.marker.getTooltip()._container).removeClass('tooltip-off');
        inst.marker.openTooltip();
      }
    }
  }

  // Opening a shared map: jump to the first annotation in the list instead of leaving
  // the view on the default map centre. Same effect as clicking that item by hand.
  function focusFirstAnnotation() {
    var $first = $("#annotations-list .annotation-item").first();
    if (!$first.length) return;
    $first.trigger("click");
  }

  // Render object in the sidebar
  function renderObjectLayer(object) {
    // Check that the object isn't already rendered in the list
    if ($(".annotation-item[data-id='"+object.id+"']").length == 0) {
      // Render the object in the list depending on the type (different data for each)
      if (object.type == "line") {
        const icon = '<svg class="annotation-icon" width="23" height="23" viewBox="0 0 23 23" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="23" height="23" rx="5" fill="'+object.color+'"/><path d="M14.5 8.5L8.5 14.5" stroke="white" stroke-width="1.5" stroke-linecap="square"/><path d="M15.8108 8.53378C16.7176 8.53378 17.4527 7.79868 17.4527 6.89189C17.4527 5.9851 16.7176 5.25 15.8108 5.25C14.904 5.25 14.1689 5.9851 14.1689 6.89189C14.1689 7.79868 14.904 8.53378 15.8108 8.53378Z" stroke="white" stroke-width="1.5"/><circle cx="6.89189" cy="15.8108" r="1.64189" stroke="white" stroke-width="1.5"/></svg>'
        $("#annotations-list").prepend('<div class="annotation-item" data-id="'+object.id+'"><div class="annotation-name"><img class="annotation-arrow" src="assets/arrow.svg">'+icon+'<span>'+object.name+'</span><img class="delete-layer" src="assets/delete.svg"></div><div class="annotation-details annotation-closed"><div class="annotation-description">'+object.desc+'</div><div class="annotation-data"><div class="annotation-data-field"><img src="assets/distance-icon.svg">'+object.distance+' km</div></div></div></div>');
      } else if (object.type == "area") {
        const icon = '<svg class="annotation-icon" width="23" height="23" viewBox="0 0 23 23" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="23" height="23" rx="5" fill="'+object.color+'"/><path d="M15.3652 8.5V13.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M8.5 15.3649H13.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M14.5303 9.03033C14.8232 8.73744 14.8232 8.26256 14.5303 7.96967C14.2374 7.67678 13.7626 7.67678 13.4697 7.96967L14.5303 9.03033ZM7.96967 13.4697C7.67678 13.7626 7.67678 14.2374 7.96967 14.5303C8.26256 14.8232 8.73744 14.8232 9.03033 14.5303L7.96967 13.4697ZM13.4697 7.96967L7.96967 13.4697L9.03033 14.5303L14.5303 9.03033L13.4697 7.96967Z" fill="white"/><circle cx="15.365" cy="6.85135" r="1.60135" stroke="white" stroke-width="1.5"/><circle cx="15.365" cy="15.3649" r="1.60135" stroke="white" stroke-width="1.5"/><circle cx="6.85135" cy="15.3649" r="1.60135" stroke="white" stroke-width="1.5"/></svg>';
        $("#annotations-list").prepend('<div class="annotation-item" data-id="'+object.id+'"><div class="annotation-name"><img class="annotation-arrow" src="assets/arrow.svg">'+icon+'<span>'+object.name+'</span><img class="delete-layer" src="assets/delete.svg"></div><div class="annotation-details annotation-closed"><div class="annotation-description">'+object.desc+'</div><div class="annotation-data"><div class="annotation-data-field"><img src="assets/area-icon.svg">'+object.area+' km&sup2;</div><div class="annotation-data-field"><img src="assets/perimeter-icon.svg">'+object.distance+' km</div></div></div></div>');
      } else if (object.type == "marker") {
        const icon = '<svg class="annotation-icon" width="23" height="23" viewBox="0 0 23 23" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="23" height="23" rx="5" fill="'+object.color+'"/><path d="M16.0252 11.2709C16.0252 14.8438 11.3002 17.9063 11.3002 17.9063C11.3002 17.9063 6.5752 14.8438 6.5752 11.2709C6.5752 10.0525 7.07301 8.8841 7.95912 8.0226C8.84522 7.16111 10.047 6.67712 11.3002 6.67712C12.5533 6.67712 13.7552 7.16111 14.6413 8.0226C15.5274 8.8841 16.0252 10.0525 16.0252 11.2709Z" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.2996 12.8021C12.1695 12.8021 12.8746 12.1166 12.8746 11.2709C12.8746 10.4252 12.1695 9.73962 11.2996 9.73962C10.4298 9.73962 9.72461 10.4252 9.72461 11.2709C9.72461 12.1166 10.4298 12.8021 11.2996 12.8021Z" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        $("#annotations-list").prepend('<div class="annotation-item" data-id="'+object.id+'"><div class="annotation-name"><img class="annotation-arrow" src="assets/arrow.svg">'+icon+'<span>'+object.name+'</span><img class="delete-layer" src="assets/delete.svg"></div><div class="annotation-details annotation-closed"><div class="annotation-description">'+object.desc+'</div><div class="annotation-data"><div class="annotation-data-field"><img src="assets/marker-small-icon.svg">'+object.lat.toFixed(5)+', '+object.lng.toFixed(5)+'</div></div></div></div>');
      }
    } else {
      // If the object already exists, update existing data
      const layer = $(".annotation-item[data-id='"+object.id+"']");
      if (object.type == "line") {
        layer.find(".annotation-name span").html(object.name);
        layer.find(".annotation-description").html(object.desc);
        layer.find(".annotation-data").html('<div class="annotation-data-field"><img src="assets/distance-icon.svg">'+object.distance+' km</div>');
      } else if (object.type == "area") {
        layer.find(".annotation-name span").html(object.name);
        layer.find(".annotation-description").html(object.desc);
        layer.find(".annotation-data").html('<div class="annotation-data-field"><img src="assets/area-icon.svg">'+object.area+' km&sup2;</div><div class="annotation-data-field"><img src="assets/perimeter-icon.svg">'+object.distance+' km</div>');
      } else if (object.type == "marker") {
        layer.find(".annotation-name span").html(object.name);
        layer.find(".annotation-description").html(object.desc);
        layer.find(".annotation-data").html('<div class="annotation-data-field"><img src="assets/marker-small-icon.svg">'+object.lat.toFixed(5)+', '+object.lng.toFixed(5)+'</div>');
      }
    }
  }

  // Delete an object from the sidebar
  function deleteLayer(e) {
    e.preventDefault();
    e.stopPropagation();
    const id = $(this).parent().parent().attr("data-id");
    const inst = objects.find(x => x.id === id);
    if (!inst) return;
    $(".annotation-item[data-id='"+id+"']").remove();
    if (inst.type != "marker") {
      if (inst.trigger) inst.trigger.remove();
      // Locally drawn lines/areas live on the Geoman layer, not on inst.line
      if (inst.line) inst.line.remove();
      else if (inst.layer) inst.layer.remove();
      deleteObject(inst.id);
      objects = $.grep(objects, function(e){
           return e.id != inst.id;
      });
    } else {
      if (inst.marker) inst.marker.remove();
      deleteObject(inst.id);
      objects = $.grep(objects, function(e){
           return e.id != inst.id;
      });
    }
  }

  // Editing the name of the map
  function editMapName() {
    if (checkAuth() == false) return;
    if (!editingname) {
      oldname = mapname;
      editingname = true;
      $("#map-name").addClass("map-editing");
    }
  }
  function focusMapName() {
    $("#map-name").select();
    $("#map-name").addClass("map-editing");
  }
  function stopEditingMapName() {
    if (checkAuth() == false) return;
    editingname = false;
    $("#map-name").removeClass("map-editing");
    var name = sanitize($("#map-name").val());
    if (name.length == 0) {
      // Revert to the old name if its length is 0
      $("#map-name").val(oldname);
    } else if (name !== oldname) {
      // Only write when it actually changed
      updateRoom({ name: name });
      oldname = name;
      mapname = name;
      $("#share-nav span").html("Share "+mapname);
    }
  }

  // Editing the description of the map
  function editMapDescription() {
    if (checkAuth() == false) return;
    if (!editingdescription) {
      olddescription = mapdescription;
      editingdescription = true;
      $("#map-description").addClass("map-editing");
    }
  }
  function focusMapDescription() {
    $("#map-description").select();
    $("#map-description").addClass("map-editing");
  }
  function stopEditingMapDescription() {
    if (checkAuth() == false) return;
    editingdescription = false;
    $("#map-description").removeClass("map-editing");
    var name = sanitize($("#map-description").val());
    if (name.length == 0) {
      // Revert to the old description if its length is 0
      $("#map-description").val(olddescription);
    } else if (name !== olddescription) {
      updateRoom({ description: name });
      olddescription = name;
    }
  }

  // Toggle annotation visibility
  function toggleAnnotations() {
    if (!$("#hide-annotations").hasClass("hidden-annotations")) {
      $(".leaflet-overlay-pane").css({"visibility": "hidden", "pointer-events":"none"});
      $(".leaflet-tooltip-pane").css({"visibility": "hidden", "pointer-events":"none"});
      $("#hide-annotations").addClass("hidden-annotations");
      $("#hide-annotations").html("Show all");
    } else {
      showAnnotations();
    }
  }
  function showAnnotations() {
    $(".leaflet-overlay-pane").css({"visibility": "visible", "pointer-events":"all"});
    $(".leaflet-tooltip-pane").css({"visibility": "visible", "pointer-events":"all"});
    $("#hide-annotations").removeClass("hidden-annotations");
    $("#hide-annotations").html("Hide all");
  }

  // Toggle dots menu
  function toggleMoreMenu() {
    if ($("#more-menu").hasClass("menu-show")) {
      $("#more-menu").removeClass("menu-show");
    } else {
      $("#more-menu").addClass("menu-show");
    }
  }

  // Show share popup
  function showSharePopup() {
    $("#share").addClass("share-show");
    $("#overlay").addClass("share-show");
  }

  // Close share popup
  function closeSharePopup() {
    if ($("#overlay").hasClass("share-show")) {
      $(".share-show").removeClass("share-show");
    }
  }

  // Copy share link
  function copyShareLink() {
    $("#share-url").focus();
    $("#share-url").select();
    document.execCommand('copy');
  }

  // Zoom in
  function zoomIn() {
    map.zoomIn();
  }

  // Zoom out
  function zoomOut() {
    map.zoomOut();
  }

  // Global click handler
  function handleGlobalClicks(e) {
    if ($("#more-menu").hasClass("menu-show") && $(e.target).attr("id") != "more-vertical" && $(e.target).parent().attr("id") != "more-vertical") {
      $("#more-menu").removeClass("menu-show");
    }
    // Close the colour swatches when clicking anywhere outside the picker
    if ($("#color-list").hasClass("color-enabled") && $(e.target).closest("#color-picker").length == 0) {
      $("#color-list").removeClass("color-enabled");
    }
  }

  // Export GeoJSON
  function exportGeoJSON() {
    var tempgroup = new L.FeatureGroup();
    map.addLayer(tempgroup);
    map.eachLayer(function(layer) {
      if (layer instanceof L.Marker || layer instanceof L.Polyline || layer instanceof L.Polygon) {
        layer.addTo(tempgroup);
      }
    });

    // Download GeoJSON locally
    var a = document.createElement("a");
    var file = new Blob([JSON.stringify(tempgroup.toGeoJSON())], {type: "application/json"});
    a.href = URL.createObjectURL(file);
    a.download = "geojson";
    a.click();
  }

  // Render user cursors
  function renderCursors(snapshot, key) {
    var user = checkAuth();
    if (checkAuth() != false) {
      if (key != user.uid) {
        if (snapshot.active) {
          if (!cursors.find(x => x.id === key)) {
            // Custom cursor icon
            var cursor_icon = L.divIcon({
              html: '<svg width="18" height="18" style="z-index:9999!important" viewBox="0 0 18 18" fill="none" style="background:none;" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M5.51169 15.8783L1.08855 3.64956C0.511984 2.05552 2.05554 0.511969 3.64957 1.08853L15.8783 5.51168C17.5843 6.12877 17.6534 8.51606 15.9858 9.23072L11.2573 11.2573L9.23074 15.9858C8.51607 17.6534 6.12878 17.5843 5.51169 15.8783Z" fill="'+snapshot.color+'"/></svg>',
              iconSize:     [22, 22], // size of the icon
              iconAnchor:   [0, 0], // point of the icon which will correspond to marker's location
              shadowAnchor: [4, 62],  // the same for the shadow
              popupAnchor:  [-3, -76], // point from which the popup should open relative to the iconAnchor
              className: "cursoricon"
            });

            // Create a marker for the cursor
            var cursor_instance = L.marker([snapshot.lat, snapshot.lng], {icon: cursor_icon, pane:"markerPane"});

            // The "tooltip" is just the name of the user that's displayed in the cursor
            cursor_instance.bindTooltip(snapshot.name, { permanent: true, offset: [14, 32], className: "cursor-label color"+snapshot.color.replace("#", ""), direction:"right"});
            cursor_instance.addTo(map)
            cursors.push({id:key, cursor:cursor_instance, color:snapshot.color, name:snapshot.name});

            // Show user avatar on the top right. If they don't have a picture, just put the initial
            var avatar = snapshot.imgsrc;
            if (avatar == null) {
              avatar = snapshot.name.charAt(0).toUpperCase();
              $("#right-nav").prepend('<div id="profile" style="background:'+snapshot.color+'!important" class="avatars" data-id="'+key+'">'+avatar+'</div>');
            } else {
              $("#right-nav").prepend('<div id="profile" style="background:'+snapshot.color+'!important" class="avatars" data-id="'+key+'"><img src="'+avatar+'"></div>');
            }
          } else {
            cursors.find(x => x.id === key).cursor.setLatLng([snapshot.lat, snapshot.lng]);
            // Observation mode
            if (observing.status == true && key == observing.id) {
              if (snapshot.zoom != null) map.setZoom(snapshot.zoom);
              if (snapshot.view_lat != null && snapshot.view_lng != null) {
                map.panTo(new L.LatLng(snapshot.view_lat, snapshot.view_lng));
              }
            }
          }
        } else if (!snapshot.active && cursors.find(x => x.id === key)) {
          // If the user has disconnected, stop observing them
          if (observing.status == true && key == observing.id) {
            stopObserving();
          }

          // Remove the avatar from the top right
          $(".avatars[data-id="+key+"]").remove();

          // Remove the cursor
          cursors.find(x => x.id === key).cursor.remove();
          cursors = $.grep(cursors, function(e){
               return e.id != key;
          });
        }
      }
    }
  }

  // Add tooltips for shapes
  function addShapeInfo(snapshot, key) {
    if (snapshot.type != "draw" && snapshot.type != "marker") {
      var user = checkAuth();
      if (checkAuth() != false) {
        var inst = objects.filter(function(result){
          return result.id === key && result.user === snapshot.user
        })[0];
        inst.completed = true;

        // Create a marker so a popup can be shown for the shape
        var centermarker = L.marker(inst.line.getBounds().getCenter(), {zIndexOffset:9999, interactive:false, pane:"overlayPane"});

        // If a marker was already set for the object, simply update the previous variable to reflect that
        if (inst.trigger != "") {
          centermarker = inst.trigger;
          centermarker.unbindTooltip();
        }

        // Create popups that show the name, description, and data of the shapes
        if (inst.type == "line") {
          centermarker.bindTooltip('<h1>'+inst.name+'</h1><h2>'+inst.desc+'</h2><div class="shape-data"><h3><img src="assets/distance-icon.svg">'+inst.distance+' km</h3></div><div class="arrow-down"></div>', {permanent: false, direction:"top", interactive:false, closeOnClick:false, autoclose:false, bubblingMouseEvents:true, className:"create-shape-flow tooltip-off", offset: L.point({x: -15, y: 18})});
        } else if (inst.type == "area") {
          centermarker.bindTooltip('<h1>'+inst.name+'</h1><h2>'+inst.desc+'</h2><div class="shape-data"><h3><img src="assets/area-icon.svg">'+inst.area+' km&sup2;</h3></div><div class="shape-data"><h3><img src="assets/perimeter-icon.svg">'+inst.distance+' km</h3></div><div class="arrow-down"></div>', {permanent: false, direction:"top", interactive:false, bubblingMouseEvents:false, className:"create-shape-flow tooltip-off" ,offset: L.point({x: -15, y: 18})});

          // Areas are lines until they are completed, when they become a polygon
          inst.line.remove();
          var polygon = L.polygon(inst.path, {color:inst.color}).addTo(map);
          inst.line = polygon;
        }

        // Hide the marker (since it's only used for positioning the popup)
        centermarker.setOpacity(0);
        centermarker.addTo(map);
        inst.trigger = centermarker;
        centermarker.getTooltip().update();

        // Detect when clicking on the shape
        inst.line.on("click", function(){
          if (!erasing) {
            // Set the marker to the cursor coordinates and show the popup
            inst.trigger.setLatLng(cursorcoords);
            inst.trigger.openTooltip();
            $(inst.trigger.getTooltip()._container).removeClass('tooltip-off');
          } else {
            // If erasing, delete the shape
            inst.trigger.remove();
            inst.line.remove();
            deleteObject(inst.id);
            objects = $.grep(objects, function(e){
                 return e.id != inst.id;
            });
            $(".annotation-item[data-id='"+inst.id+"']").remove();
          }
        });

        // Detect when closing the popup
        inst.line.on("tooltipclose", function(){
          // De-select the object from the sidebar list
          $(".annotation-item[data-id="+inst.id+"]").find(".annotation-name span").removeClass("annotation-focus");
        });

        // Render the object in the sidebar list
        renderObjectLayer(inst);
      }
    }
  }

  // Render a new object
  function renderShape(snapshot, key) {
    var user = checkAuth();
    if (checkAuth() != false) {
      if (snapshot.type == "draw" || snapshot.type == "line" || snapshot.type == "area") {
        if (objects.filter(function(result){
          return result.id === key && result.user === snapshot.user
        }).length == 0) {
          // If the shape doesn't exist locally, create it
          // (fall back to the first stored coordinate if the row has no seed point)
          var seed = [snapshot.initlat, snapshot.initlng];
          if ((seed[0] == null || seed[1] == null) && snapshot.coords && snapshot.coords[0]) {
            seed = snapshot.coords[0].set;
          }
          var line = L.polyline([seed], {color: snapshot.color});
          if (snapshot.completed && (snapshot.type == "line" || snapshot.type == "area")) {
            // If the shape is already finished, give it all its coordinates
            line = L.polyline(snapshot.path, {color:snapshot.color});
          }
          line.addTo(map);

          // Save shape locally
          if (snapshot.type == "area") {
              objects.push({id:key, local:false, user:snapshot.user, color: snapshot.color, line:line, name:snapshot.name, desc:snapshot.desc, distance:snapshot.distance, area:snapshot.area, path:snapshot.path, completed:snapshot.completed, type:snapshot.type, trigger:"", session:snapshot.session});
          } else {
              objects.push({id:key, local:false, user:snapshot.user, color: snapshot.color, line:line, name:snapshot.name, desc:snapshot.desc, distance:snapshot.distance, path:snapshot.path, completed:snapshot.completed, type:snapshot.type, trigger:"", session:snapshot.session});
          }

          // Detect when clicking on the shape (for freedrawing only)
          line.on("click", function(e){
            if (snapshot.completed && snapshot.type == "draw" && erasing) {
              // If erasing, delete the line
              line.remove();
              deleteObject(key);
              objects = $.grep(objects, function(e){
                   return e.id != key;
              });
            }
          });

          // Detect when hovering over a line
          line.on("mouseover", function(event){
            if (erasing && snapshot.type == "draw") {
              line.setStyle({opacity: .3});
            }
          });

          // Detect mouseout on a line
          line.on("mouseout", function(event){
            if (snapshot.type == "draw") {
              line.setStyle({opacity: 1});
            }
          });
        } else {
          // If the object already exists (drawing in progress or already completed), update the coordinates of the object
          var coords = [];
          Object.values(snapshot.coords || {}).forEach(function(coord){
            coords.push([coord.set[0], coord.set[1]]);
          });
          var local = objects.filter(function(result){
            return result.id === key && result.user === snapshot.user
          })[0];
          // Never blank out a shape because a payload arrived without coordinates
          if (coords.length > 0) local.line.setLatLngs(coords);
        }
      } else if (snapshot.type == "marker") {
        if (objects.filter(function(result){
          return result.id === key && result.user === snapshot.user
        }).length == 0) {
          // If the marker doesn't exist locally, create it
          var marker_icon;
          if (snapshot.m_type == "none") {
            // Set custom marker icon
            marker_icon = L.divIcon({
              html: '<svg width="30" height="30" viewBox="0 0 46 46" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M23 44.0833C23 44.0833 40.25 32.5833 40.25 19.1666C40.25 14.5916 38.4326 10.204 35.1976 6.96903C31.9626 3.73403 27.575 1.91663 23 1.91663C18.425 1.91663 14.0374 3.73403 10.8024 6.96903C7.56741 10.204 5.75 14.5916 5.75 19.1666C5.75 32.5833 23 44.0833 23 44.0833ZM28.75 19.1666C28.75 22.3423 26.1756 24.9166 23 24.9166C19.8244 24.9166 17.25 22.3423 17.25 19.1666C17.25 15.991 19.8244 13.4166 23 13.4166C26.1756 13.4166 28.75 15.991 28.75 19.1666Z" fill="'+snapshot.color+'"/>/svg>',
              iconSize:     [30, 30], // size of the icon
              iconAnchor:   [15, 30], // point of the icon which will correspond to marker's location
              shadowAnchor: [4, 62],  // the same for the shadow
              popupAnchor:  [-3, -76] // point from which the popup should open relative to the iconAnchor
            });
          } else {
            // If the marker is of a place found using "find nearby", use a different icon
            var marker_icon = L.icon({
              iconUrl: 'assets/'+snapshot.m_type+'-marker.svg',
              iconSize:     [30, 30],
              iconAnchor:   [15, 30],
              shadowAnchor: [4, 62],
              popupAnchor:  [-3, -76]
            });
          }
          var marker = L.marker([snapshot.lat, snapshot.lng], {icon:marker_icon, interactive:true, direction:"top", pane:"overlayPane"});

          // Create the popup that shows data about the marker
          marker.bindTooltip('<h1>'+snapshot.name+'</h1><h2>'+snapshot.desc+'</h2><div class="shape-data"><h3><img src="assets/marker-small-icon.svg">'+snapshot.lat.toFixed(5)+', '+snapshot.lng.toFixed(5)+'</h3></div><div class="arrow-down"></div>', {permanent: false, direction:"top", className:"create-shape-flow tooltip-off", interactive:false, bubblingMouseEvents:false, offset: L.point({x: 0, y: -35})});
          marker.addTo(map);
          marker.openTooltip();

          // Save the marker locally
          objects.push({id:key, user:snapshot.user, marker:marker, color:snapshot.color, name:snapshot.name, desc:snapshot.desc, session:snapshot.session, local:false, lat:snapshot.lat, lng:snapshot.lng, completed:true, type:"marker"});

          // Detect when clicking on the marker
          marker.on("click", function(e){
            if (!erasing) {
              // Show the popup
              $(marker.getTooltip()._container).removeClass('tooltip-off');
              marker.openTooltip();
            } else {
              // If erasing, delete the marker
              marker.remove();
              deleteObject(key);
              objects = $.grep(objects, function(e){
                   return e.id != key;
              });
              $(".annotation-item[data-id='"+key+"']").remove();
            }
          })

          // Detect when closing the popup
          marker.on("tooltipclose", function(){
            // De-select the marker from the sidebar list
            $(".annotation-item[data-id="+key+"]").find(".annotation-name span").removeClass("annotation-focus");
          });
          marker.closeTooltip();

          // Render the marker in the sidebar list
          renderObjectLayer(objects.find(x => x.id == key));
        } else {
          // If the marker already exists locally, just update its info in the sidebar list
          renderObjectLayer(objects.find(function(result){
            return result.id === key && result.user === snapshot.user;
          }));
        }
      }
      if (snapshot.completed) {
        if (objects.filter(function(result){
          return result.id === key && result.user === snapshot.user
        }).length > 0) {
          // If the shape is completed and it exists locally, update its data
          var inst = objects.filter(function(result){
            return result.id === key && result.user === snapshot.user
          })[0];
          inst.name = snapshot.name;
          inst.desc = snapshot.desc;
          if (snapshot.type == "area") {
            inst.area = snapshot.area;
            inst.distance = snapshot.distance;
            inst.path = snapshot.path;
          } else {
            inst.distance = snapshot.distance;
          }
          addShapeInfo(snapshot, key);
        }
      }
    }
  }

  // Update object coordinates
  function updateShapeCoords(snapshot,key) {
    var user = checkAuth();
    if (checkAuth() != false) {
      if (snapshot.type == "draw" || snapshot.type == "line" || snapshot.type == "area") {
        if (objects.filter(function(result){
          return result.id === key && result.user === snapshot.user
        }).length > 0) {
          var coords = [];
          Object.values(snapshot.coords || {}).forEach(function(coord){
            coords.push([coord.set[0], coord.set[1]]);
          });
          if (coords.length > 0) {
            objects.filter(function(result){
              return result.id === key && result.user === snapshot.user
            })[0].line.setLatLngs(coords);
          }
        }
      }
    }
  }

  // A room_users row arrived (initial load or realtime change)
  function handleUserRow(row) {
    if (!row) return;
    userCache[row.user_id] = row;
    // Presence decides who is really online; until it has synced, render optimistically
    if (!onlineIds || onlineIds[row.user_id]) {
      renderCursors(Object.assign({}, row, { active: true }), row.user_id);
    }
  }

  // Reconcile the cursors on screen with who is actually connected
  function syncOnlineCursors() {
    Object.keys(userCache).forEach(function(uid){
      if (onlineIds[uid]) {
        handleUserRow(userCache[uid]);
      } else if (cursors.find(x => x.id === uid)) {
        renderCursors({ active: false }, uid);
      }
    });
  }

  // Realtime Presence replaces Firebase's onDisconnect(): socket closes are detected
  // by the server, so cursors disappear immediately instead of after a timeout.
  function subscribePresence() {
    presenceChannel = supabaseClient.channel("room-presence:" + room, {
      config: { presence: { key: currentUser.uid } }
    });

    presenceChannel.on("presence", { event: "sync" }, function(){
      var state = presenceChannel.presenceState();
      onlineIds = {};
      Object.keys(state).forEach(function(uid){ onlineIds[uid] = true; });
      syncOnlineCursors();
    });

    presenceChannel.on("presence", { event: "leave" }, function(payload){
      if (payload && payload.key && payload.key !== currentUser.uid) {
        renderCursors({ active: false }, payload.key);
      }
    });

    presenceChannel.subscribe(function(status){
      if (status === "SUBSCRIBED") {
        presenceChannel.track({ online_at: new Date().toISOString() });
      }
    });
  }

  // Remove an annotation locally (it was deleted by someone else, or by another tab)
  function removeObjectLocally(id) {
    if (!id) return;
    var inst = objects.find(function(x){ return x.id === id; });
    if (!inst) return;

    if (inst.type == "draw") {
      inst.line.remove();
    } else if (inst.type == "marker") {
      if (inst.marker) inst.marker.remove();
    } else {
      if (inst.trigger) inst.trigger.remove();
      if (inst.local) {
        if (inst.layer) inst.layer.remove();
      } else if (inst.line) {
        inst.line.remove();
      }
    }
    $(".annotation-item[data-id='"+id+"']").remove();
    objects = $.grep(objects, function(e){ return e.id != id; });
  }

  // Realtime subscriptions for one room (replaces Firebase's .on('value' / 'child_*'))
  function subscribeRoom() {
    supabaseClient.channel("room-db:" + room)
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: "id=eq." + room }, function(payload){
        if (payload.eventType === "DELETE") return;
        var row = payload.new;
        mapname = row.name || "";
        mapdescription = row.description || "";
        if (!editingname) $("#map-name").val(mapname);
        if (!editingdescription) $("#map-description").val(mapdescription);
        $("#share-nav span").html("Share "+mapname);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "room_users", filter: "room_id=eq." + room }, function(payload){
        if (payload.eventType === "DELETE") {
          if (payload.old && payload.old.user_id) {
            delete userCache[payload.old.user_id];
            renderCursors({ active: false }, payload.old.user_id);
          }
          return;
        }
        handleUserRow(payload.new);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "room_objects", filter: "room_id=eq." + room }, function(payload){
        if (payload.eventType === "DELETE") {
          removeObjectLocally(payload.old && payload.old.id);
          return;
        }
        var row = shapeFromRow(payload.new);
        // Our own edits are already applied locally, but another tab of the same user is not
        if (row.user_id === currentUser.uid && row.session === session) return;
        try {
          renderShape(row, row.id);
          if (payload.eventType === "UPDATE") updateShapeCoords(row, row.id);
        } catch (err) {
          console.error("[supabase] realtime shape:", err.message);
        }
      })
      .subscribe(function(status, err){
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("[supabase] realtime:", status, err && err.message);
        }
      });
  }

  // Interact with the database
  async function checkData() {
    if (checkAuth() == false || dataLoaded) return;
    dataLoaded = true;

    // Register this user in the room: creates the row on first visit and bumps the
    // per-visit session counter (used to tell our own edits apart from other tabs).
    var joined = await supabaseClient.rpc("join_room", {
      p_room_id: room,
      p_name: currentUser.displayName,
      p_imgsrc: currentUser.photoURL,
      p_color: colors[Math.floor(Math.random()*colors.length)],
      p_view_lat: map.getBounds().getCenter().lat,
      p_view_lng: map.getBounds().getCenter().lng,
      p_zoom: map.getZoom()
    });
    if (joined.error) {
      dataLoaded = false;
      return console.error("[supabase] join_room:", joined.error.message);
    }
    session = joined.data;
    $(".signin").removeClass("signin");

    // Get name and description of the map on startup
    var details = await supabaseClient.from("rooms").select("name,description").eq("id", room).single();
    if (details.error) console.error("[supabase] room:", details.error.message);
    if (details.data) {
      mapname = details.data.name || "";
      mapdescription = details.data.description || "";
      $("#map-name").val(mapname);
      $("#map-description").val(mapdescription);
      $("#share-nav span").html("Share "+mapname);
    }

    // Users already in the room
    var users = await supabaseClient.from("room_users").select("*").eq("room_id", room);
    if (users.error) console.error("[supabase] room_users:", users.error.message);
    (users.data || []).forEach(function(row){
      try { handleUserRow(row); } catch (err) { console.error("[supabase] cursor:", err.message); }
    });

    // Annotations already on the map. Ordered oldest-first so that the sidebar
    // (which .prepend()s each row) keeps showing the newest annotation on top.
    var objs = await supabaseClient.from("room_objects").select("*").eq("room_id", room)
      .order("created_at", { ascending: true });
    if (objs.error) console.error("[supabase] room_objects:", objs.error.message);
    (objs.data || []).forEach(function(row){
      // One malformed row should never stop the rest of the map from loading
      try {
        var shape = shapeFromRow(row);
        renderShape(shape, row.id);
        // Freehand strokes keep their whole path in `coords` (they never get a `path`
        // column), and renderShape only seeds them with a single point. Without this
        // every saved stroke came back as an invisible one-pixel dot after a reload.
        if ((!shape.path || !shape.path.length) && shape.coords && shape.coords.length) {
          updateShapeCoords(shape, row.id);
        }
      } catch (err) { console.error("[supabase] shape:", err.message); }
    });

    // Opening a shared link: focus the first annotation instead of the default view
    focusFirstAnnotation();

    subscribePresence();
    subscribeRoom();
  }

  // Keyboard shortcuts & more
  $(document).keyup(function(e) {
    if ($(e.target).is("input") || $(e.target).is("textarea")) {
      return;
    }
    if (e.key === "Escape") {
      normalMode();
    } else if (e.key === "Enter") {
      if (editingname) {
        stopEditingMapName();
      } else if (editingdescription) {
        stopEditingMapDescription();
      }
    } else if (e.which == 86) {
      cursorTool();
    } else if (e.which == 80) {
      penTool();
    } else if (e.which == 69) {
      eraserTool();
    } else if (e.which == 77) {
      markerTool();
    } else if (e.which == 76) {
      pathTool();
    } else if (e.which == 65) {
      areaTool();
    }
  });

  // Leave the room cleanly when the tab closes/refreshes.
  // Realtime Presence handles abrupt disconnects on its own; this is the best-effort path.
  window.addEventListener("pagehide", function(){
    Object.keys(coordBuffers).forEach(function(id){ flushCoords(id); });
    if (presenceChannel) presenceChannel.untrack();
    if (room && currentUser) {
      supabaseClient.from("room_users").update({ active: false })
        .eq("room_id", room).eq("user_id", currentUser.uid).then(logResult);
    }
  });

  // Event handlers
  $(document).on("click", handleGlobalClicks);
  $(document).on("click", "#pen-tool", penTool);
  $(document).on("click", "#cursor-tool", cursorTool);
  $(document).on("click", "#eraser-tool", eraserTool);
  $(document).on("click", "#marker-tool", markerTool);
  $(document).on("click", "#area-tool", areaTool);
  $(document).on("click", "#path-tool", pathTool);
  $(document).on("click", ".color", switchColor);
  $(document).on("click", "#inner-color", toggleColor);
  $(document).on("mouseover", ".tool", showTooltip);
  $(document).on("mouseout", ".tool", hideTooltip);
  $(document).on("click", ".save-button", saveForm);
  $(document).on("click", ".cancel-button", cancelForm);
  $(document).on("click", ".avatars", observationMode);
  $(document).on("click", ".annotation-arrow", toggleLayer);
  $(document).on("click", ".annotation-item", focusLayer);
  $(document).on("click", ".delete-layer", deleteLayer);
  $(document).on("mousedown", "#map-name", editMapName);
  $(document).on("mouseup", "#map-name", focusMapName);
  $(document).on("focusout", "#map-name", stopEditingMapName);
  $(document).on("mousedown", "#map-description", editMapDescription);
  $(document).on("mouseup", "#map-description", focusMapDescription);
  $(document).on("focusout", "#map-description", stopEditingMapDescription);
  $(document).on("click", "#hide-annotations", toggleAnnotations);
  $(document).on("click", "#location-control", targetLiveLocation);
  $(document).on("click", ".find-nearby", findNearby);
  $(document).on("click", ".save-button-place", saveNearby);
  $(document).on("click", ".cancel-button-place", cancelNearby);
  $(document).on("click", "#more-vertical", toggleMoreMenu);
  $(document).on("click", "#geojson", exportGeoJSON);
  $(document).on("click", "#search-box img", search);
  $(document).on("submit", "#auth-form", submitAuth);
  $(document).on("click", "#auth-switch span", toggleAuthMode);
  $(document).on("click", "#create-map", createMap);
  $(document).on("click", "#logout", logOut);
  $(document).on("click", "#share-button", showSharePopup);
  $(document).on("click", "#overlay", closeSharePopup);
  $(document).on("click", "#close-share", closeSharePopup);
  $(document).on("click", "#share-copy", copyShareLink);
  $(document).on("click", "#zoom-in", zoomIn);
  $(document).on("click", "#zoom-out", zoomOut);

  // Search automatically when focused & pressing enter
  $(document).on("keydown", "#search-input", function(e){
    if (e.key === "Enter") {
      search();
    }
  });

  // Iniialize the map. Could also be done after signing in (but it's less pretty)
  initMap();

  // Get live location of the current user. Only if Geolocation is activated (local only)
  liveLocation();
});
