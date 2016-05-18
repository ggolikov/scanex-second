var L = require('leaflet');
var xhr = require('xhr');
var rbush = require('rbush');
var extent = require('geojson-extent');
var _ = require('lodash');
var turf = global.turf = require('turf');

// iterate over loaded data
function eachAsync(collection, iterator, callback) {
  var iterate = function(i) {
    setTimeout(function() {
      iterator(collection[i], i);
      if (i < collection.length) {
        iterate(i + 1);
      } else {
        callback();
      }
    });
  };
  iterate(0);
}

// map
var map = global.map = L.map('map', { minZoom: 4})
.setView([55.75, 37.6], 10);

// basemap
L.tileLayer('http://{s}.tile.osm.org/{z}/{x}/{y}.png', {
  attribution: '&copy; ' +
    '<a href="http://osm.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

var indexTree,
    searchTree,
    coverage;

// loading geoJSON
var fileUploader = document.getElementById("file");
fileUploader.addEventListener("change", getJSON, false);

function getJSON() {
  var file = this.files[0];
  var reader = new FileReader();
  reader.onload = function() {
    onLoad(JSON.parse(reader.result));
  }
  reader.readAsText(file);
};

// create tree & store data in tree
function processGeoJSON(geojson, callback) {
  var features = geojson.features;
  var chunkLength = 500;
  var chunks = _.chunk(features, chunkLength);

  var indexTree = index = rbush();

  eachAsync(chunks, function(features, index) {
    if (!features) return;

    var nodes = [];
    for (var i = features.length - 1; i >= 0; i--) {
      var feature = features[i];
      feature.properties = feature.properties || {};
      feature.properties.id = index * chunkLength + i;

      // get bbox
      var bbox = extent(feature);
      feature.bbox = bbox;

      // index tree node [xmin, ymin, xmax, ymax, feature]
      nodes.push(bbox.slice().concat([feature]));
    }

    // put features in spatial index in chunks (faster)
    indexTree.load(nodes);
  }, function() {
    geojson.features = _.flatten(chunks);
    callback(indexTree);
  });
}

// remove overlays
function removeOverlays(tree){
  searchTree = rbush();
  var deleted = 0;

  // sort geoJSON data by id
  var searched = tree.all().sort(function(a,b) {
    return a[4].properties.id - b[4].properties.id;
  });
  searchTree.insert(searched[0]);

  // removing overlapping features
  for (var i = 1; i < searched.length; i++) {
    var item = searched[i];
    var bottomLeft  = [item[0], item[1], item[0], item[1]];
    var topLeft     = [item[0], item[3], item[0], item[3]];
    var topRight    = [item[2], item[3], item[2], item[3]];
    var bottomRight = [item[0], item[3], item[0], item[3]];

    if (
      searchTree.collides(bottomLeft) &&
      searchTree.collides(topLeft) &&
      searchTree.collides(bottomRight) &&
      searchTree.collides(topRight)
      ) {
        tree.remove(item);
    } else {
        searchTree.insert(item);
    }
  }
}

// executes when file is loaded
function onLoad(geojson) {

  // store tree and geojson with bboxes
  processGeoJSON(geojson, function(indexTree) {

    // removing data from tree
    removeOverlays(indexTree);

    map.on('viewreset', renderBounds);
    map.on('move', renderBounds);

    // rendering data
    renderBounds();
  });
}

// render data
function renderBounds() {

  // get data from tree
  var bounds = map.getBounds();
  var screenBbox = bounds.toBBoxString().split(',').map(parseFloat);
  var result = searchTree.search(screenBbox).map(function(node) {
    return node[4];
  })

  if (coverage) {
    map.removeLayer(coverage);
  }

  // add layer to map
  coverage = global.coverage = L.geoJson(turf.featurecollection(result), {
    style: function(feature) {
      return {
        fillOpacity: 0.1,
        weight: 1,
        noClip: true
      };
    }
  }).addTo(map);
}
