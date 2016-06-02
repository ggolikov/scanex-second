var rbush  = require('rbush');
var extent = require('geojson-extent');
var _      = require('lodash');
var turf   = global.turf = require('turf');

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
var map = global.map = L.map('map', {
  minZoom: 0,
  preferCanvas: true
}).setView([55.75, 37.5], 9);
var checkbox = document.querySelector('#remove-overlaps');
var renderAll = !checkbox.checked;

// basemap
L.tileLayer('http://{s}.tile.osm.org/{z}/{x}/{y}.png', {
  attribution: '&copy; ' +
    '<a href="http://osm.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

var indexTree;

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

  indexTree = rbush();

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
      feature.centroid = turf.centroid(feature);

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

// executes when file is loaded
function onLoad(geojson) {

  // store tree and geojson with bboxes
  processGeoJSON(geojson, function(indexTree) {

    // redraw if checked
    L.DomEvent.on(checkbox, 'change', function() {
      if(global.overlays) {
        renderAll = !checkbox.checked;
        global.overlays.redraw();
      }
    });
    // rendering data
    renderBounds(geojson);
  });
}

// displaying overlays
function renderBounds(polygons) {
  var canvasOverlay = global.overlays = new L.CanvasOverlay(drawingOnCanvas)
    .drawing(drawingOnCanvas)
    .addTo(map);

  function drawingOnCanvas(canvasOverlay, params) {

    // load visible elements
    var bounds = params.bounds.toBBoxString().split(',').map(parseFloat);
    var polys  = indexTree.search(bounds).sort(function(a, b) {
      return a[4].properties.id - b[4].properties.id;
    }).sort(function (a, b) {
      return a[0] < b[0] ? (a[1] - b[1] ? 1 : -1) : -1;
    });

    // offscreen canvas
    var parentNode = params.canvas.parentNode;
    parentNode.removeChild(params.canvas);

    // get canvas context
    var ctx = params.canvas.getContext('2d');
    var w = params.canvas.width, h = params.canvas.height;
    var buffer = 1;

    ctx.clearRect(0, 0, params.canvas.width, params.canvas.height);

    // cut offscreen parts of polygons
    var pxBounds = new L.Bounds(
      map.latLngToContainerPoint(params.bounds.getSouthWest()).add([1, -1]),
      map.latLngToContainerPoint(params.bounds.getNorthEast()).add([-1, 1])
    );

    for (var i = 0, len = polys.length; i < len; i++) {
      ctx.strokeStyle = "rgba(65,105,225, 1.5)";
      ctx.fillStyle   = "rgba(65,105,225, 0.1)";
      var feature = polys[i][4];
      var coords  = feature.geometry.coordinates[0];
      var transformed = [];

      var mbr = [Infinity, Infinity, -Infinity, -Infinity];
      var pt;

      // transform latlngs to screen coordinates
      for (var j = 0; j < coords.length; j++) {
        pt = map.latLngToContainerPoint([coords[j][1], coords[j][0]]);
        transformed[j] = pt;

        // calculate mbr in screen coordinates
        mbr[0] = Math.min(mbr[0], pt.x);
        mbr[1] = Math.min(mbr[1], pt.y);
        mbr[2] = Math.max(mbr[2], pt.x);
        mbr[3] = Math.max(mbr[3], pt.y);
      }

      mbr[0] = Math.max(pxBounds.min.x, mbr[0]);
      mbr[1] = Math.max(pxBounds.min.y, mbr[1]);
      mbr[2] = Math.min(pxBounds.max.x, mbr[2]);
      mbr[3] = Math.min(pxBounds.max.y, mbr[3]);

      transformed = L.PolyUtil.clipPolygon(transformed, pxBounds);
      if (transformed.length === 0) {
        continue;
      }

      // expand mbr to accomodate line width
      mbr[0] -= buffer;
      mbr[1] -= buffer;
      mbr[2] += buffer;
      mbr[3] += buffer;

      var data   = ctx.getImageData(mbr[0], mbr[1], mbr[2] - mbr[0], mbr[3] - mbr[1]);
      var pixels = data.data;
      var width  = mbr[2] - mbr[0];

      var values = [];
      var checks = 0, index;

      // normalize indexes
      for (var j = 0, jj = transformed.length; j < jj; j++) {
        pt = transformed[j] = transformed[j]._floor();
        index = ((pt.y - mbr[1]) * width + (pt.x - mbr[0])) * 4 + 3;
        if (pixels[index]) {
          checks++;
        } else break;
      }

      // calculate centroid
      var c = centroid(transformed)._floor();
      index = ((c.y - mbr[1]) * width + (c.x - mbr[0])) * 4 + 3;
      checks += (pixels[index] ? 1 : 0);

      transformed.push(c);

      ctx.fillStyle = "rgba(65,105,225, 0.1)";

      if (!renderAll && checks === transformed.length) {
        continue;
      }

      // draw
      if (transformed.length > 1) {
        ctx.beginPath();
        ctx.moveTo(transformed[0].x, transformed[0].y);

        for (var k = 0, kk = transformed.length - 1; k < kk; k++) {
          ctx.lineTo(transformed[k].x, transformed[k].y);
        }
        ctx.lineWidth = 0;
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
      }
    }
    parentNode.appendChild(params.canvas);
  }
}

// calculate centroid
function centroid(pts) {
  var len = pts.length;
  var off = pts[0];
  var twicearea = 0;
  var x = 0;
  var y = 0;
  var p1, p2, f;

  for (var i = 0, j = len - 1; i < len; j = i++) {
    p1 = pts[i];
    p2 = pts[j];
    f = (p1.y - off.y) * (p2.x - off.x) -
        (p2.y - off.y) * (p1.x - off.x);
    twicearea += f;

    x += (p1.x + p2.x - 2 * off.x) * f;
    y += (p1.y + p2.y - 2 * off.y) * f;
  }
  f = twicearea * 3;
  return L.point(x / f + off.x, y / f + off.y);
}


L.DomEvent.on(document, 'unload', function() {
  if (indexTree) {
    indexTree.clear();
  }
});
