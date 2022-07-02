# Mapus
![Preview](preview.gif)
<br>
Maps with real-time collaboration 🗺️

Mapus is a tool to explore and annotate collaboratively on a map. You can draw, add markers, lines, areas, find places to go, observe other users, and much more.

<a href="https://www.producthunt.com/posts/mapus?utm_source=badge-top-post-badge&utm_medium=badge&utm_souce=badge-mapus" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=307018&theme=light&period=weekly" alt="Mapus - An open source map tool with real-time collaboration | Product Hunt" style="width: 250px; height: 54px;" width="250" height="54" /></a>

> You can support this project (and many others) through [GitHub Sponsors](https://github.com/sponsors/alyssaxuu)! ❤️

Made by [Alyssa X](https://alyssax.com)

## Table of contents
- [Features](#features)
- [Installing Mapus](#installing-mapus)
- [Miscellaneous ideas](#miscellaneous-ideas)
   - [Feature ideas](#feature-ideas)
   - [Potential use cases](#potential)
   - [Monetization](#monetization) 
- [Libraries used](#libraries-used)

## Features
🙌 Real-time collaboration to help plan trips synchronously<br>
✏️ Draw to highlight areas on the map<br>
📏 Create lines to designate paths and measure distance<br>
📐 Create areas to mark different zones<br>
📍 Create markers to save places on the map<br>
☕️ Find places and things to do nearby<br>
🔍 Search and navigate to specific places<br>
👀 Observe other users by clicking on their avatar<br>
📝 View a list of all the annotations, and toggle their visibility<br>
💾 Export the map data as GeoJSON<br>
...and much more - all for free!<br>


It's basically Google's [MyMaps](https://www.google.com/maps/about/mymaps/), except it has real-time collaboration.

## Installing Mapus
Since real-time multiplayer can get expensive (even though Firebase has a pretty generous free plan), you'll need to self-host Mapus to use it. Here's how:

1. Download the code. In the web version of GitHub, you can do that by clicking the green "Code" button, and then "Download ZIP". You'll be using the src folder.
2. Create a Firebase account and project. You can check out the [docs](https://firebase.google.com/docs/web/setup?authuser=0) to see how to get started.
3. Create a Realtime Database. You may need to set up specific rules to keep the data safe, [here's](https://firebase.google.com/docs/database/security?authuser=0) an overview. The default rules though will work fine for testing and development, just not for production.
4. Enable Google Sign In in the Firebase console. [Here's how](https://firebase.google.com/docs/auth/web/google-signin?authuser=0).
5. Replace the Firebase config object in the [index.html](https://github.com/alyssaxuu/mapus/blob/8d8d914f97fac60d9e60e1978b8b064c0d888ef6/src/index.html#L152) file with your own. The [docs](https://firebase.google.com/docs/web/setup?authuser=0#config-object) explain how to get the object.
6. In order for the authentication to work, you need to run Mapus in a server. [Here's](https://stackoverflow.com/questions/38497334/how-to-run-html-file-on-localhost) a few ways to do it in localhost. Then go to the Firebase console, click on "Authenthication" in the sidebar, then on the "Sign-in method" tab and add your domain (or localhost) in the authorized domains list.
7. At this point you could just use the tool as is, but if you want to make sure you don't go over the Firebase free plan limits, you could set up the [Firebase Emulator](https://firebase.google.com/docs/emulator-suite/install_and_configure?authuser=0) and run everything locally 100% for free.

Note that since Mapus has a MIT License you are free to set it up in a domain or even commercialize it.

## Miscellaneous ideas
Throughout the development of Mapus I've had several ideas in regards to additional features, potential use cases, and more. I thought it would be a good idea to share, if anyone wants to contribute to Mapus, or make their own version.

### <a name="feature-ideas"></a>Feature ideas 🚀
- <b>A list of maps in the dashboard created by or shared with the user.</b> There's [this plugin](https://github.com/grinat/leaflet-simple-map-screenshoter) that creates screenshots of a Leaflet map, it could be useful to generate thumbnails (saving them in Firebase storage).
- <b>Routing, to show a path between 2 points.</b> I considered adding this feature in launch, but ended up deciding against it due to requiring a backend or paying for an API. There's several plugins for this for Leaflet, one of the main ones I saw is [Leaflet Routing Machine](https://www.liedman.net/leaflet-routing-machine/).
- <b>Sharing options.</b> I made [a mockup](https://i.ibb.co/BPn763m/sharingthing.png) for this, basically allowing users to invite others by email and setting view-only/edit access. In order to set this up I would have had to rely on a third party to send out emails for invites, or create it myself. Since it's a self-hosted tool it didn't make much sense to implement.
- <b>Autocomplete for search.</b> Unfortunately the free API I'm using for getting OSM data ([Nominatim](https://nominatim.org/)) doesn't allow using it for autocomplete (understandably so, it's a free tool and it would lead to a really high amount of requests). Other APIs that could be used instead (paid) would be the [Google Places API](https://developers.google.com/maps/documentation/places/web-service/search), or the [MapBox Geocoding API](https://docs.mapbox.com/api/search/geocoding/).
- <b>Showing places of interest as you move around the map.</b> Because of a similar API restriction, I set it up so that places of interest only show on request by the user within their view area, limited to 10 at a time (although it could go up to 50). The Google Places API would probably be a good replacement here.
- <b>Text tool.</b> I looked all over for a Leaflet plugin to add text to maps. While there's several ways to add labels, there isn't really a proper way to deal with interactive text. The closest one I found was [this one](https://github.com/rumax/Leaflet.Editable.TextBox), but it had its limitations.

### <a name="potential"></a>Potential use cases 🤔
- The first use case I thought of when building this product was <b>planning a trip between friends</b>. There's tools like [MyMaps](https://www.google.com/maps/about/mymaps/) that can be used for this, but it's only for asynchronous collaboration, being unable to see each other in real-time and still mostly relying on people letting you know they updated the map. With real-time collaboration it's much easier to suggest things like hotels to stay at, restaurants to go, hiking routes, etc.
- I also considered how Mapus could be targeted to companies. I had several ideas in that regard, for example, <b>planning some sort of company event</b>, deciding on where to <b>open a new store or make a new development</b> (e.g. based on amenities in the area, type of properties), <b>all sorts of real estate purposes</b> (finding emerging neighbourhoods, property valuations, etc)...
- The real-time collaboration aspect of Mapus would be particularly handy in rapidly changing situations. For example in a <b>natural disaster</b> it could be a way to quickly gather data from different sources as to the status of an area, <b>coordinating rescue efforts</b>, etc. It could even be more helpful if <b>traffic or weather data</b> was integrated in the tool, or if there was a way for users to integrate their own APIs to use the data collaboratively.
- A more "out there" use case could be something similar to [Hoodmaps](https://hoodmaps.com/london-neighborhood-map), having <b>public maps</b> where anyone can contribute information about a place, such as <b>best places to live, work, explore</b>, etc. It would require a lot of moderation though so it might not be very feasible.

### <a name="monetization"></a>Monetization 💵
- Since it's a costly tool to run due to having real-time collaboration, it would need a way to make money to be self-sustainable. One way to do this would be similar to Google Maps, having <b>local businesses promote themselves in the tool</b> by making themselves more prominent on the maps.
- Another way would simply be having different plans, a <b>basic free version</b> for a few people to collaborate on a trip together (either with a limited history, maximum number of users, maximum number of maps per user, limited features, limited "working area" in a map...), and then <b>paid plans</b> with more features or targeted to enterprise.

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
