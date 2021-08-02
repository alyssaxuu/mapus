# Mapus
![Preview](https://media.giphy.com/media/GYC39vBRIUZMWr2wwZ/giphy.gif)
<br>
Maps with real-time collaboration 🗺️

Mapus is a tool to explore and annotate collaboratively on a map. You can draw, add markers, lines, areas, find places to go, observe other users, and much more.

Made by [Alyssa X](https://alyssax.com)

## Table of contents
- [Features](#features)
- [Installing Mapus](#self-hosting-mapus)
- [Libraries used](#libraries-used)

## Features
🙌 Real-time collaboration to help plan trips synchronously
✏️ Draw to highlight areas on the map
📏 Create lines to designate paths and measure distance
📐 Create areas to mark different zones
📍 Create markers to save places on the map
☕️ Find places and things to do nearby
🔍 Search and navigate to specific places
👀 Observe other users by clicking on their avatar
📝 View a list of all the annotations, and toggle their visibility
💾 Export the map data as GeoJSON
...and much more - all for free!


It's basically Google's [MyMaps](google.com/mymaps), except it has real-time collaboration.

## Installing Mapus
Since real-time multiplayer can get expensive (even though Firebase has a pretty generous free plan), you'll need to self-host Mapus to use it. Here's how:

1. Download the code. In the web version of GitHub, you can do that by clicking the green "Code" button, and then "Download ZIP". You'll be using the src folder.
2. Create a Firebase account and project. You can check out the [docs](https://firebase.google.com/docs/web/setup?authuser=0) to see how to get started.
3. Create a Realtime Database. You may need to set up specific rules to keep the data safe, [here's](https://firebase.google.com/docs/database/security?authuser=0) an overview. The default rules though will work fine for testing and development, just not for production.
4. Enable Google Sign In in the Firebase console. [Here's how](https://firebase.google.com/docs/auth/web/google-signin?authuser=0)
5. Replace the Firebase config object in the [index.html](https://github.com/alyssaxuu/mapus/blob/8d8d914f97fac60d9e60e1978b8b064c0d888ef6/src/index.html#L152) file with your own. The [docs](https://firebase.google.com/docs/web/setup?authuser=0#config-object) explain how to get the object.
6. At this point you could just use the tool as is, but if you want to make sure you don't go over the Firebase free plan limits, you could set up the [Firebase Emulator](https://firebase.google.com/docs/emulator-suite/install_and_configure?authuser=0) and run everything locally 100% for free.

Note that since Mapus has a MIT License you are free to set it up in a domain or even commercialize it.

## Libraries used

- [jQuery](https://jquery.com/) -  for better event handling and DOM manipulation
- [Leaflet](https://leafletjs.com/) -  for the interactive map
- [Leaflet Geoman](https://geoman.io/leaflet-geoman) -  for drawing lines and polygons on top of the map
- [Turf](https://turfjs.org/) -  for calculating areas and distances
- [Firebase](https://firebase.google.com/) -  for the database
- [OpenStreetMap](https://www.openstreetmap.org/) - for the Nominatim API to search for places
- [MapBox](https://www.mapbox.com/) - for the tile seen in the GIF. The current version uses an OSM tile because it's free

#
 Feel free to reach out to me through email at hi@alyssax.com or [on Twitter](https://twitter.com/alyssaxuu) if you have any questions or feedback! Hope you find this useful 💜
