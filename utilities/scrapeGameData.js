// bring in needed modules
var fs = require('fs'),
	program = require('commander'),
	xpath = require('xpath'),
  	dom = require('xmldom').DOMParser,
  	xml2js = require('xml2js'),
  	dir = require('node-dir'),
  	path = require('path'),
  	rest = require('restler'),
  	util = require('util'),
  	baseModel = require('../app/models/baseModel'),
	Item = require('../app/models/item'),
	Ship = require('../app/models/ship'),
	Ammo = require('../app/models/ammo');
	Client = require('node-rest-client');

// set up initial variables and settings
var	parser = new xml2js.Parser({'mergeAttrs' : true, 'explicitArray' : false}),
	ignorePortTypes = ['Seat', 'Player', 'FuelIntake', 'Light'],
	ignorePortFlags = ['debug'];

var filesToParse = [];

program
  .version('0.0.1')
  .option('-s, --submit', 'Submit parsed data to database')
  .option('-w, --write', 'Write .json files for parsed data')
  .option('-i, --input <path>', 'Set the input path for gamedata XML')
  .option('-o, --output [path]', 'Set the output path for any saved .json files')
  .option('-a, --api <url>', 'Set the API root to use for submissions -- Should end in /')
  .parse(process.argv);

  if (program.input === undefined) {
  	console.log('Input path is required to operate.  Use --input <path> to specify the input path');
  	process.exit(1);
  }

  if (program.api && program.api.charAt(program.api.length - 1) != '/') {
  	program.api += '/';
  }

  if (program.submit && !program.api) {
  	console.log('API URL is required when the submit option is enabled')
  	process.exit(1);
  }

  if (program.wrote && !program.output) {
  	console.log('An output path is required when the write option is enabled')
  	process.exit(1);
  }

// Utility functions
function hasIgnoredFlag(element) {
	if (ignorePortFlags.indexOf(element) > -1) {
		return true;
	}
	return false;
}

function isItemPortNameInList(node, validList) {
	if (node != undefined) {
		if (node.attributes != undefined) {
			if (node.attributes.getNamedItem("name") != undefined) {
				if (node.attributes.getNamedItem("name").value != undefined) {
					var value = node.attributes.getNamedItem("name").value;
					for (var i = 0; i < validList.length; i++) {
						// console.log("Looking to see if node named '" + value + "' is valid for filter '" + validList[i] + "'");
						if (value.indexOf(validList[i]) >= 0) {
							return true;
						}
					}
				}
			}
		}
	}
	return false;
}

function setPartStateForSharedID(sharedID, state) {

}

function ProcessNextFile() {
	// Process next file in list of files to process
	var input = filesToParse.pop();
	if (input != undefined)
	{
		fs.readFile(input, {encoding: 'utf8' }, function(err, data) {
			parseXML(null, data, input, null);
		});
	}
	else
		console.log("No more files to process");
}

function parseXML(err, content, filename, next) {
	// console.log("--->Parsing " + filename);
    var doc = new dom().parseFromString(content)
    var root = doc.firstChild;
    var rootName = root.localName;
    if (rootName === null) {
    	console.log("Unrecognized Root - Trying to find valid sibling");
    	while(rootName === null && root.nextSibling !== null) {
    		root = root.nextSibling;
    		rootName = root.localName;
    	}
    }
    if (rootName === null) {
    	console.log('Unable to find valid root in XML\n\t' + filename);
    }
    else {
    switch (rootName.toLowerCase()) {
	    	case 'item':
	    		console.log(filename);
				var itemName = xpath.select("//item", doc)[0].getAttribute('name');
				var itemClass = xpath.select("//item", doc)[0].getAttribute('class');
				if (itemClass.toLowerCase() == "vehicleitemmissile")
					parseMissile(doc, itemName);
				else
	    			parseItem(doc, itemName);
	    		break;
	    	case 'ammo':
	    		console.log(filename);
				var ammoName = xpath.select("//ammo", doc)[0].getAttribute('name');
	    		parseAmmo(doc, ammoName);
	    		break;
	    	case 'vehicle':
	    		// look to see if this file contains data for Variants and if so preprocess each before sending it to parseVehicle
	    		var modifications = xpath.select("//Modifications", doc);
	    		if (modifications.length > 0) {
    				preParseXMLForVariant(content, filename);
	    		}
	    		else {
					var vehicleName = xpath.select("//Vehicle", doc)[0].getAttribute('name');
		    		parseVehicle(doc, vehicleName);
	    		}
	    		break;
	    	default:
	    		console.log('Found Unknown XML');
	    		// console.log("\t" + filename);
				ProcessNextFile();
	    }

    }
    if (next != null) next();
};

function preParseXMLForVariant(content, filename) {
	console.log("Pre-Parsing " + filename + " for Variant Data");
	var originalDoc = new dom().parseFromString(content);
	var vehicleName = xpath.select("//Vehicle", originalDoc)[0].getAttribute('name');
	var modifications = xpath.select("//Modifications/Modification", originalDoc);
	for (var i = 0; i < modifications.length; i++) {
		parser.parseString(modifications[i], function(err, result) {
			var mod = result.Modification;
			console.log("\tFound Variant named " + mod.name);
			var variantDoc = new dom().parseFromString(content);
			var modElems = result.Modification.Elems;
			if (modElems !== undefined && modElems.Elem !== undefined) {
				for (var j = 0; j < modElems.Elem.length; j++) {
					var elem = modElems.Elem[j];
					// console.log("\t\tSearching for element ID: " + elem.idRef);
					var elementRef = xpath.select("//*[@id='" + elem.idRef + "']", variantDoc);
					if (elementRef.length > 0) {
						var attribute = elementRef[0].attributes.getNamedItem(elem.name);
						if (attribute !== undefined) {
							// console.log('\t\t\tChanging ' + elem.name + ' from ' + elementRef[0].attributes.getNamedItem(elem.name).value + ' to ' + elem.value);
							elementRef[0].setAttribute(elem.name, elem.value);
							// console.log('\t\t\t' + elementRef[0].attributes.getNamedItem(elem.name).value)
						}
					}
				}
				// console.log(variantDoc.toString());
			}
			parseVehicle(variantDoc, vehicleName + "_" + mod.name);
		});
	}
}

function parseVehicle(doc, vehicleName) {
	console.log("Parsing Vehicle XML: " + vehicleName);
    // Basic data
    var finalJSON = {};
    var vehicle = xpath.select("//Vehicle", doc);
	parser.parseString(vehicle, function (err, result) {
		finalJSON['name'] = vehicleName.toLowerCase();
		finalJSON['category'] = result['Vehicle']['category'];
		finalJSON['displayName'] = result['Vehicle']['displayname'];
		finalJSON['className'] = result['Vehicle']['classname'];
		finalJSON['class'] = result['Vehicle']['class'];
		finalJSON['hudPaletteScheme'] = result['Vehicle']['HudPaletteScheme'];
		var shortCode = vehicleName.split("_")[0].toLowerCase().trim();
		if (baseModel.manufactorCodes.indexOf(shortCode) > -1) {
			finalJSON['manufactorCode'] = shortCode;
		}
		else {
			// fallback to try and cross reference form the old method CIG used
			if (baseModel.oldManufactorPrefixMapping['shortCode'] !== undefined) {
				finalJSON['manufactorCode'] = baseModel.oldManufactorPrefixMapping['shortCode'];
			}
		}
		if (finalJSON['manufactorCode'] !== undefined) {
			var manufactor = baseModel.manufactorMapping[finalJSON['manufactorCode']];
			if (manufactor !== undefined) {
				finalJSON['manufactor'] = manufactor;
			}
		}
		console.log("Manufactor Code: " + finalJSON['manufactorCode']);
		console.log("Manufactor: " + finalJSON['manufactor']);
		var crossSection = result['Vehicle']['crossSectionMultiplier'];
		if (crossSection !== undefined) {
			var crossSectionMultipliers = crossSection.split(",");
			finalJSON['crossSection'] = {
				'x' : crossSectionMultipliers[0],
				'y' : crossSectionMultipliers[1],
				'z' : crossSectionMultipliers[2]
			}
		}
		// Movement
		var movement = result['Vehicle']['MovementParams']['Spaceship']
		if (movement !== undefined) {
		finalJSON['movement'] = {
		        'engineWarmupDelay' : movement['engineWarmupDelay'],
		        'engineIgnitionTime' : movement['engineIgnitionTime'],
		        'enginePowerMax' : movement['enginePowerMax'],
		        'rotationDamping' : movement['rotationDamping'],
		        'maxCruiseSpeed' : movement['maxCruiseSpeed'], 
		        'maxBoostSpeed' : movement['maxBoostSpeed'],
		        'maxEngineThrust' : movement['maxEngineThrust'],
		        'maxRetroThrust' : movement['maxRetroThrust'],
		        'maxDirectionalThrust' : movement['maxDirectionalThrust'],
		        'maxJerk' : movement['maxJerk'],
		        'maxAngJerk' : movement['maxAngJerk'],
		        'maxAngularVelocity' : {
		            "packed" : movement['maxAngularVelocity']
		        },
		        'maxAngularAcceleration' : {
		            "packed" : movement['maxAngularAcceleration']
		        }
			}
		if (result['Vehicle']['MovementParams']['Spaceship']['IFCS'] != undefined
			&& result['Vehicle']['MovementParams']['Spaceship']['IFCS']['TunedParams'] != undefined 
			&& finalJSON['movement'] != undefined) {
				var tunedParams = result['Vehicle']['MovementParams']['Spaceship']['IFCS']['TunedParams'];
				finalJSON['movement']['cruiseTime'] = tunedParams['cruiseTime'] ? tunedParams['cruiseTime']['value'] : undefined;
				finalJSON['movement']['boostScale'] = tunedParams['boost'] ? tunedParams['boost']['scale'] : undefined;
			}
		}
		// Damage Multipliers
		var damagesBase = result['Vehicle']['Damages']
		// console.log(damagesBase);
		if (damagesBase !== undefined && damagesBase['DamageMultipliers'] !== undefined) {
			var damages = damagesBase['DamageMultipliers']["DamageMultiplier"].length === undefined ? [damagesBase['DamageMultipliers']["DamageMultiplier"]] : damagesBase['DamageMultipliers']["DamageMultiplier"];
			// console.log(damages[0]["DamageMultiplier"][0]);
			finalJSON['damageMultipliers'] = {};
			for (var i = 0; i < damages.length; i++) {
				// console.log(damages[i]);
				if (damages[i]['damageType'] == 'bullet') {
					if (damages[i]['multiplier'] !== undefined)
						finalJSON['damageMultipliers']['physical'] = damages[i]['multiplier'];
					if (damages[i]['multiplier_energy'] !== undefined)
						finalJSON['damageMultipliers']['energy'] = damages[i]['multiplier_energy'];
					if (damages[i]['multiplier_distortion'] !== undefined)
						finalJSON['damageMultipliers']['distortion'] = damages[i]['multiplier_distortion'];
				}
				else if (damages[i]['damageType'] == 'collision') {
					if (damages[i]['multiplier'] !== undefined)
						finalJSON['damageMultipliers']['collision'] = damages[i]['multiplier'];
				}
				else if (damages[i]['damageType'] == 'explosion') {
					if (damages[i]['multiplier'] !== undefined)
						finalJSON['damageMultipliers']['explosion'] = damages[i]['multiplier'];
				}
			}
		}
		// signatures
		var signaturesBase = result['Vehicle']['Signatures'];
		if (signaturesBase !== undefined && signaturesBase['Signature'] !== undefined) {
			finalJSON['signatures'] = [];
			var signatures = signaturesBase['Signature'].length === undefined ? [signaturesBase['Signature']] : signaturesBase['Signature'];
			for (var i = 0; i < signatures.length; i++) {
				finalJSON['signatures'].push({
					'signatureType' : signatures[i].type,
					'signatureValue' : signatures[i].value
				});
			}
		}
	});
	// mass
	var massParts = xpath.select("//Part[@mass]", doc);
	finalJSON['mass'] = 0;
	for (var i = 0; i < massParts.length; i++) {
		parser.parseString(massParts[i], function(err, result) {
			finalJSON['mass'] += Number(result['Part']['mass']);
		});
	}
    // ItemPorts
    // we don't go straight to the ItemPorts under Parts, but instead look
    // for the ItemPorts defiend under Seat actions and use that to generate a
    // list of ItemPorts to use.  This way when an ItemPort is disabled by a
    // Variant modification, we will automaticly do the same.  As best I can tell
    // this is how the game itself does it as well.
    var allItemPorts = [];
    var seats = xpath.select("//SeatActions", doc);
    if (seats.length > 0){
	    var seatItemPorts = xpath.select("//ItemPort", seats[0]);
	    if (seatItemPorts.length > 0) {
	    	for (var i = 0; i < seatItemPorts.length; i++) {
	    		var part = seatItemPorts[i].attributes.getNamedItem("part");
	    		if (part !== undefined) {
	    			if (part.value.trim().length > 0) {
		    			allItemPorts.push(part.value.replace("*", ""));
	    			}
	    		}
	    	}
	    }
    }
    // console.log(allItemPorts);
    // Addtionally, a SECOND method the game uses is that a part can be set to be
    // "skipped" by setting skipPart="1".  This requires a lot more work to handle
    // but if an ItemPort is attached to such a part, we need to skip it.
    //
    // When finding our ports, unfortunately we can't just search by name because
    // some of the ports are wildcards.  So we have to get ALL ItemPorts and then
    // filter based on the names.
    if (allItemPorts.length > 0) {
	    var ItemPorts = [];
		var nodes = xpath.select("//Part[@class='ItemPort']", doc);
		if (nodes.length > 0) {
			for (var i = 0; i < nodes.length; i++) {
				if (isItemPortNameInList(nodes[i], allItemPorts)) {
		    		if (nodes[i] !== undefined) {
					    var shouldAddPort = true;
						parser.parseString(nodes[i], function (err, result) {
							// we walk UP the node tree to see if any parent parts that
							// this is in are marked as "skipPart"
							var start = nodes[i]
							while(start.parentNode != null) {
								start = start.parentNode;
								if (start.attributes != undefined) {
									var attr = start.attributes.getNamedItem("skipPart");
									if (attr != undefined) {
										if (attr.value == "1"){
											shouldAddPort = false;
										}
									}
								}
							}
							var part = result.Part;
							var port = result.Part.ItemPort;
							if (port !== undefined) {
								var ItemPort = {
									'name' : part['name'],
									'minSize' : Number(port['minsize']),
									'maxSize' : Number(port['maxsize'])
								}
								if (port['display_name'] != undefined) {
									ItemPort['displayName'] = port['display_name'];
								}
								if (port['flags'] != undefined) {
									ItemPort['flags'] = port['flags'].split(' ');
									if (ItemPort['flags'].some(hasIgnoredFlag)) shouldAddPort = false;
								}
								if (port['Pitch'] != undefined) {
									ItemPort['pitch'] = {
										'min' : Number(port['Pitch']['min']),
										'max' : Number(port['Pitch']['max'])
									}
									if (port['Pitch']['scale'] != undefined) {
										ItemPort['pitch']['scale'] = Number(port['Pitch']['scale']);
									}
								}
								if (port['Yaw'] != undefined) {
									ItemPort['yaw'] = {
										'min' : Number(port['Yaw']['min']),
										'max' : Number(port['Yaw']['max'])
									}
									if (port['Yaw']['scale'] != undefined) {
										ItemPort['yaw']['scale'] = Number(port['Yaw']['scale']);
									}
								}
								if (port['Roll'] != undefined) {
									ItemPort['roll'] = {
										'min' : Number(port['Roll']['min']),
										'max' : Number(port['Roll']['max'])
									}
									if (port['Roll']['scale'] != undefined) {
										ItemPort['roll']['scale'] = Number(port['Roll']['scale']);
									}
								}
								if (port['Types'] != undefined) {
									ItemPort['compatibleTypes'] = [];
									var types = port['Types']['Type'];
									if (types.length != undefined) {
										for (var j = 0; j < types.length; j++) {
											var type = { 'itemType' : types[j]['type'] };
											if (ignorePortTypes.indexOf(type.type) > -1) shouldAddPort = false;
											var subtype = types[j]['subtypes'];
											if (subtype != undefined) {
												subtype = subtype.split(',');
												if (subtype.length == 1) {
													if (subtype != '') {
														type['itemSubtypes'] = subtype;
													}
												}
												else {
													type['itemSubTypes'] = subtype;
												}
											}
											ItemPort['compatibleTypes'].push(type);
										}
									}
									else {
										var type = { 'itemType' : types['type'] };
										if (ignorePortTypes.indexOf(type.type) > -1) shouldAddPort = false;
										var subtype = types['subtypes'];
										if (subtype != undefined) {
											subtype = subtype.split(',');
											if (subtype.length == 1) {
												if (subtype != '') {
													type['itemSubTypes'] = subtype;
												}
											}
											else {
												type['itemSubTypes'] = subtype;
											}
										}
										ItemPort['compatibleTypes'].push(type);
									}
								}
								else shouldAddPort = false;
								if (shouldAddPort) {
									ItemPorts.push(ItemPort);
								}
							}
						});    
		    		}
				}
			}
    	}
    }
    finalJSON['itemPorts'] = ItemPorts;
    if (program.write) {
	    var outFilePath = path.join(program.output, vehicleName + '.json');
		fs.writeFile(outFilePath, JSON.stringify(finalJSON, null, 4), function(err) {
		    if(err) {
		      console.log(err);
		    }
		    console.log("Written to JSON " + outFilePath);
		}); 
    }
    if (program.submit) {
		// Submit document to the API.  First determine if it exists or not.  If so do an update (PUT) otherwise submit a new document (POST)
		rest.get(program.api + 'ships/name/' + finalJSON['name']).on('404', function(data, response) {
			// 404 response from the API means document was not found, so this doesn't already exist.  We need to create it with a POST
			// console.log('Existing SHIP ' + finalJSON['name'] + ' document not found -- POSTing a new document.')
			rest.postJson(program.api + 'ships?api_key=971d43e3d3672cb54b8f28cd0b63d153', finalJSON).on('success', function(data, response) {
				console.log("\tSuccessfully POSTed new document");
				// console.log("\t\t" + util.inspect(response.rawEncoded, {depth: null}));
			}).on('error', function(err, response) {
					console.error('[ERROR] -- Received an unkown error while POSTing new SHIP ' + finalJSON['name'] + ' document')
					console.error(err);
					console.error(response);
				}).on('complete', function(result, response){
					ProcessNextFile();
				});
		}).on('success', function(data, response) {
			// Success response back means a document with this name is already in the databse, so we use PUT to simply update it with the new data
			console.log('Existing SHIP ' + finalJSON['name'] + ' already exists -- PUTing an updated document.')
			rest.putJson(program.api + 'ships?api_key=971d43e3d3672cb54b8f28cd0b63d153', finalJSON).on('success', function(data, response) {
				console.log("\tSuccessfully PUT updated document");
			});
		}).on('error', function(err, response) {
			// Something went wrong!
			console.error('[ERROR] -- Received an unkown error while checking to see if SHIP ' + finalJSON['name'] + ' exists')
			console.error(err);
			console.error(response);
		}).on('complete', function(result, response){
			ProcessNextFile();
		});
		// rest.postJson('https://api.stantonspacebarn.com/ships', finalJSON).on('complete', function(data, response) {
    }
};

function getParam(root, paramName) {
	if (root === undefined || root === null) return undefined;
	if (root.length == undefined) root = [root];
	for (var i = 0; i < root.length; i++) {
		if (root[i]['name'] === paramName) {
			return root[i]['value'];
		}
	}
	return undefined;
}
function getValue(root, paramName) {
	if (root === undefined || root === null || root[paramName] == undefined) return undefined;
	return root[paramName]['value'];
}

function parseItem(doc, itemName) {
	console.log("Parsing Item XML: " + itemName);
    // Basic data
    var finalJSON = {};
    var vehicle = xpath.select("//item", doc);
    var paramsRoot = null;
	parser.parseString(vehicle, function (err, result) {
		// console.log(util.inspect(result, {depth: null}));
		finalJSON['name'] = itemName.toLowerCase();
		finalJSON['category'] = result['item']['category'];
		finalJSON['invisible'] = result['item']['invisible'];
		finalJSON['class'] = result['item']['class'];
		var splitName = itemName.split("_");
		var shortCode = splitName[0].toLowerCase().trim();
		if (baseModel.manufactorCodes.indexOf(shortCode) > -1) {
			finalJSON['manufactorCode'] = shortCode;
		}
		else {
			// if we didn't find a match in the first part, try the second
			if (splitName.length >= 2) {
				shortCode = splitName[1].toLowerCase().trim();
				if (baseModel.manufactorCodes.indexOf(shortCode) > -1) {
					finalJSON['manufactorCode'] = shortCode;
				}
			}
		}
		if (finalJSON['manufactorCode'] === undefined) {
			// fallback to try and cross reference form the old method CIG used
			if (baseModel.oldManufactorPrefixMapping['shortCode'] !== undefined) {
				finalJSON['manufactorCode'] = baseModel.oldManufactorPrefixMapping['shortCode'];
			}
		}
		if (finalJSON['manufactorCode'] !== undefined) {
			var manufactor = baseModel.manufactorMapping[finalJSON['manufactorCode']];
			if (manufactor !== undefined) {
				finalJSON['manufactor'] = manufactor;
			}
		}
		if (result['item']['params'] != undefined) {
			paramsRoot = result['item']['params']['param'];
			finalJSON['params'] = {
				'mountable' : getParam(paramsRoot, 'mountable'),
				'itemType' : getParam(paramsRoot, 'itemType'),
				'itemSubType' : getParam(paramsRoot, 'itemSubType'),
				'itemSize' : getParam(paramsRoot, 'itemSize'),
				'itemClass' : getParam(paramsRoot, 'itemClass'),
				'displayName' : getParam(paramsRoot, 'display_name'),
				'itemDescription' : getParam(paramsRoot, 'itemDescription'),
				'mass' : getParam(paramsRoot, 'mass'),
				'hitpoints' : getParam(paramsRoot, 'hitpoints'),
				'inefficiency' : getParam(paramsRoot, 'inefficiency'),
				'forceWaitRetract' : getParam(paramsRoot, 'forceWaitRetract'),
				'weaponRequireAmmoBox' : getParam(paramsRoot, 'weaponRequireAmmoBox'),
				'weaponDelayChangeAmmoBox' : getParam(paramsRoot, 'weaponDelayChangeAmmoBox'),
				'itemTags' : getParam(paramsRoot, 'itemTags'),
				'requiredPortTags' : getParam(paramsRoot, 'requiredPortTags'),
			};
			if (finalJSON['manufactor'] === undefined) {
				finalJSON['manufactor'] = getParam(paramsRoot, 'itemManufactor');
			}
			if (result['item']['params']['itemStats'] != undefined) {
				paramsRoot = result['item']['params']['itemStats'];
				finalJSON['params']['itemStats'] = {
					'damage' : getValue(paramsRoot, 'Damage'),
					'rateOfFire' : getValue(paramsRoot, 'RoF'),
					'range' : getValue(paramsRoot, 'Range'),
					'power' : getValue(paramsRoot, 'Power'),
					'warhead' : getValue(paramsRoot, 'Warhead'),
					'concuss' : getValue(paramsRoot, 'Concuss'),
					'radius' : getValue(paramsRoot, 'Radius'),
					'speed' : getValue(paramsRoot, 'Speed')
				};
			}
		}

		if (result['item']['heatOverflow'] != undefined) {
			paramsRoot = result['item']['heatOverflow']['param'];
			finalJSON['heatOverflow'] = {
				'damageLevel' : getParam(paramsRoot, 'damageLevel'),
				'damageMin' : getParam(paramsRoot, 'damageMin'),
				'damageMax' : getParam(paramsRoot, 'damageMax'),
				'damageTick' : getParam(paramsRoot, 'damageTick'),
				'cooldownTime' : getParam(paramsRoot, 'cooldownTime'),
			};
		}
		if (result['item']['ammoBox'] != undefined) {
			paramsRoot = result['item']['ammoBox']['parm'];
			finalJSON['ammoBox'] = {
				'ammoName' : getParam(paramsRoot, 'ammo_name'),
				'maxAmmoCount' : getParam(paramsRoot, 'max_ammo_count')
			};
		}
		if (result['item']['identifier'] != undefined) {
			paramsRoot = result['item']['identifier']['param'];
			finalJSON['identifier'] = {
				'identifyTime' : getParam(paramsRoot, 'identifyTime'),
				'numTargetsAllowed' : getParam(paramsRoot, 'numTargetsAllowed')
			};
		}
		if (result['item']['targetSelector'] != undefined) {
			paramsRoot = result['item']['targetSelector']['param'];
			finalJSON['targetSelector'] = {
				'numTargetsAllowed' : getParam(paramsRoot, 'numTargetsAllowed')
			};
		}
		if (result['item']['battery'] != undefined) {
			paramsRoot = result['item']['battery']['param'];
			finalJSON['battery'] = {
				'chargeRate' : getParam(paramsRoot, 'chargeRate'),
				'capacity' : getParam(paramsRoot, 'capacity'),
				'output' : getParam(paramsRoot, 'output'),
				'dynamicPipe' : getParam(paramsRoot, 'dynamicPipe')
			};
		}
		if (result['item']['QDrive'] != undefined) {
			paramsRoot = result['item']['QDrive']['param'];
			finalJSON['qdrive'] = {
				'driveSpeed' : getParam(paramsRoot, 'driveSpeed'),
				'spoolUpTime' : getParam(paramsRoot, 'spoolUpTime'),
				'rampUpTime' : getParam(paramsRoot, 'rampUpTime'),
				'rampDownTime' : getParam(paramsRoot, 'rampDownTime')
			};
		}
		if (result['item']['radar'] != undefined) {
			paramsRoot = result['item']['radar']['param'];
			finalJSON['radar'] = {
				// 'searchRadius' : getValue(result['item']['radar']['param'], 'searchRadius'),
				// 'radarType' : getValue(result['item']['radar']['param'], 'radar_type'),
				// 'gridSize' : getValue(result['item']['radar']['param'], 'grid_size'),
				// 'signalRangeModifier' : getValue(result['item']['radar']['param'], 'signal_range_modifer'),
				// 'signalAntennaGain' : getValue(result['item']['radar']['param'], 'signal_antenna_gain'),
				'maxSearchRadius' : getParam(result['item']['radar']['param'], 'maxSearchRadius')
				// 'signalTransmitPower' : getValue(result['item']['radar']['param'], 'signal_transmit_power')
			};
			if (result['item']['radar']['Detectors'] != undefined) {
				finalJSON['radar']['Detectors'] = [];
				for (var i = 0; i < result['item']['radar']['Detectors']['Detector'].length; i++) {
					var sig = {
						'signature' : result['item']['radar']['Detectors']['Detector'][i]['signal'],
						'amplifier' : result['item']['radar']['Detectors']['Detector'][i]['amplifier'],
						'occlusionMultiplier' : result['item']['radar']['Detectors']['Detector'][i]['occlusionMultiplier'],
						'occlusionMin' : result['item']['radar']['Detectors']['Detector'][i]['occlusionMin'],
						'occlusionMax' : result['item']['radar']['Detectors']['Detector'][i]['occlusionMax'],
						'stopAtOcclusion' : result['item']['radar']['Detectors']['Detector'][i]['stopAtOcclusion'],
						'signalExponential' : result['item']['radar']['Detectors']['Detector'][i]['signalExponential'],
						// 'signatureMultiplier' : result['item']['radar']['Detectors']['Detector'][i]['signatureMultiplier'],
						// 'signatureRangeMultiplier' : result['item']['radar']['Detectors']['Detector'][i]['signatureRangeMultiplier'],
						// 'signatureThreshold' : result['item']['radar']['Detectors']['Detector'][i]['signatureThreshold']
					}
					finalJSON['radar']['Detectors'].push(sig);
				}
			}
		}
		if (result['item']['shield'] != undefined &&
			result['item']['shield']['data'] != undefined) {
			paramsRoot = result['item']['shield']['data']['param'];
			finalJSON['shield'] = {
				'data' : {
					'shieldFaceType' : getParam(paramsRoot, 'shieldFaceType'),
					'shieldMaxHitpoints' : getParam(paramsRoot, 'shieldMaxHitpoints'),
					'shieldMaxRegenRate' : getParam(paramsRoot, 'shieldMaxRegenRate'),
					'shieldRegenDelay' : getParam(paramsRoot, 'shieldRegenDelay'),
					'shieldMaxHPShift' : getParam(paramsRoot, 'shieldMaxHPShift'),
					'shieldMaxRegenShift' : getParam(paramsRoot, 'shieldMaxRegenShift'),
					'shieldHpAllocRate' : getParam(paramsRoot, 'shieldHpAllocRate'),
					'maxLevelModifier' : getParam(paramsRoot, 'maxLevelModifier'),
					'shieldDamageAbsorbFactorPhysical' : getParam(paramsRoot, 'shieldDamageAbsorbFactor'),
					'shieldDamageAbsorbFactorEnergy' : getParam(paramsRoot, 'shieldDamageAbsorbFactor_Energy'),
					'shieldDamageAbsorbFactorDistortion' : getParam(paramsRoot, 'shieldDamageAbsorbFactor_Distortion'),
				}
			};
		}
		if (result['item']['gimbal'] != undefined) {
			var base = result['item']['gimbal'];
			finalJSON['gimbal'] = {
				'gimbalType' : base['type']
			};
			if (base['pitch'] != undefined) {
				finalJSON['gimbal']['pitch'] = {
					'min' : base['pitch']['min'],
					'max' : base['pitch']['max'],
					'speed' : base['pitch']['speed'],
					'accel' : base['pitch']['accel']
				};
			}
			if (base['yaw'] != undefined) {
				finalJSON['gimbal']['yaw'] = {
					'min' : base['yaw']['min'],
					'max' : base['yaw']['max'],
					'speed' : base['yaw']['speed'],
					'accel' : base['yaw']['accel']
				};
			}
			if (base['roll'] != undefined) {
				finalJSON['gimbal']['roll'] = {
					'min' : base['roll']['min'],
					'max' : base['roll']['max'],
					'speed' : base['roll']['speed'],
					'accel' : base['roll']['accel']
				};
			}
		}
		if (result['item']['thrusters'] != undefined
			&& result['item']['thrusters']['thruster'] != undefined) {
			var base = result['item']['thrusters']['thruster'];
			finalJSON['thruster'] = {
				'thrusterType' : base['type'],
				'flags' : base['flags'],
				'maxThrust' : base['maxThrust'],
				'boostThrust' : base['boostThrust'],
				'speed': base['speed'],
				'acceleration' : base['acceleration'],
				'rotationScale' : base['rotationScale'],
				'retroScale' : base['retroScale']
			};
			if (base['Pitch'] != undefined) {
				finalJSON['thruster']['pitch'] = {
					'min' : base['Pitch']['min'],
					'max' : base['Pitch']['max'],
					'speed' : base['Pitch']['speed'],
					'accel' : base['Pitch']['accel']
				};
			}
			if (base['yaw'] != undefined) {
				finalJSON['thruster']['yaw'] = {
					'min' : base['Yaw']['min'],
					'max' : base['Yaw']['max'],
					'speed' : base['Yaw']['speed'],
					'accel' : base['Yaw']['accel']
				};
			}
			if (base['Roll'] != undefined) {
				finalJSON['thruster']['roll'] = {
					'min' : base['Roll']['min'],
					'max' : base['Roll']['max'],
					'speed' : base['Roll']['speed'],
					'accel' : base['Roll']['accel']
				};
			}
			if (base['flaps'] != undefined) {
				base = base['flaps'];
				finalJSON['thruster']['flaps'] = {
					'speed' : base['speed']
				};
				if (base['flap'] != undefined) {
					finalJSON['thruster']['flaps']['flaps'] = [];
					for (var i = 0; i < base['flap'].length; i++) {
						var flap = {
							'name' : base['flap'][i]['name'],
							'min' : base['flap'][i]['min'],
							'max' : base['flap'][i]['max']
						};
						finalJSON['thruster']['flaps']['flaps'].push(flap);
					}
				}
			}
		}
		if (result['item']['turretParams'] != undefined) {
			var base = result['item']['turretParams'];
			finalJSON['turretParams'] = {
				'maxInstability' : base['maxInstability'],
			}
			if (base['pitch'] != undefined) {
				finalJSON['turretParams']['pitch'] = {
					'min' : base['pitch']['limits'] ? base['pitch']['limits'].split(',')[0].trim() : undefined,
					'max' : base['pitch']['limits'] ? base['pitch']['limits'].split(',')[1].trim() : undefined,
					'speed' : base['pitch']['speed'],
					'accel' : base['pitch']['accel']
				};
			}
			if (base['yaw'] != undefined) {
				finalJSON['turretParams']['yaw'] = {
					'min' : base['yaw']['limits'] ? base['yaw']['limits'].split(',')[0].trim() : undefined,
					'max' : base['yaw']['limits'] ? base['yaw']['limits'].split(',')[1].trim() : undefined,
					'speed' : base['yaw']['speed'],
					'accel' : base['yaw']['accel']
				};
			}
			if (base['roll'] != undefined) {
				finalJSON['turretParams']['roll'] = {
					'min' : base['roll']['limits'] ? base['roll']['limits'].split(',')[0].trim() : undefined,
					'max' : base['roll']['limits'] ? base['roll']['limits'].split(',')[1].trim() : undefined,
					'speed' : base['roll']['speed'],
					'accel' : base['roll']['accel']
				};
			}
		}
		if (result['item']['firemodes'] != undefined
			&& result['item']['firemodes']['firemode'] != undefined) {
			finalJSON['firemodes'] = [];
			var base = result['item']['firemodes'];
			var modes = base['firemode'].length === undefined ? [base['firemode']] : base['firemode'];
			for (var i = 0; i < modes.length; i++) {
				var firemode = {
					'name' : modes[i]['name'],
					'firemodeType' : modes[i]['type']
				};
				if (modes[i]['fire'] != undefined) {
					var paramsRoot = modes[i]['fire']['param'];
					firemode['fire'] = {
						'ammoType' : getParam(paramsRoot, 'ammo_type'),
						'rate' : getParam(paramsRoot,'rate'),
						'clipSize' : getParam(paramsRoot,'clip_size'),
						'maxClips' : getParam(paramsRoot,'max_clips'),
						'aiVsPlayerDamage' : getParam(paramsRoot,'ai_vs_player_damage'),
						'damage' : getParam(paramsRoot,'damage'),
					};
				}
				if (modes[i]['burst'] != undefined) {
					var paramsRoot = modes[i]['burst']['param'];
					firemode['burst'] = {
						'numShots' : getParam(paramsRoot, 'nshots'),
						'rate' : getParam(paramsRoot,'rate'),
					};
				}
				if (modes[i]['rapid'] != undefined) {
					var paramsRoot = modes[i]['rapid']['param'];
					firemode['rapid'] = {
						'minRate' : getParam(paramsRoot, 'min_rate'),
						'minSpeed' : getParam(paramsRoot, 'min_speed'),
						'maxSpeed' : getParam(paramsRoot, 'max_speed'),
						'acceleration' : getParam(paramsRoot, 'acceleration'),
						'deceleration' : getParam(paramsRoot, 'deceleration')
					};
				}
				if (modes[i]['spread'] != undefined) {
					var paramsRoot = modes[i]['spread']['param'];
					firemode['spread'] = {
						'min' : getParam(paramsRoot, 'min'),
						'max' : getParam(paramsRoot, 'max'),
						'attack' : getParam(paramsRoot, 'attack'),
						'delay' : getParam(paramsRoot, 'delay')
					};
				}
				if (modes[i]['heating'] != undefined) {
					var paramsRoot = modes[i]['heating']['param'];
					firemode['heating'] = {
						'attack' : getParam(paramsRoot, 'attack'),
						'duration' : getParam(paramsRoot, 'duration'),
						'decay' : getParam(paramsRoot, 'decay')
					};
				}
				if (modes[i]['pools'] != undefined) {
					firemode['pools'] = [];
					var pools = modes[i]['pools']['pool'].length === undefined ? [modes[i]['pools']['pool']] : modes[i]['pools']['pool'];
					for (var j = 0; j < pools.length; j++) {
						var pool = {
							'poolClass' : pools[j]['class'],
							'value' : pools[j]['value']
						};
						firemode['pools'].push(pool);
					}
				}
				finalJSON['firemodes'].push(firemode);
			}
		}
		if (result['item']['signatureReductor'] != undefined && result['item']['signatureReductor']['param'] != undefined) {
			console.log(result['item']['signatureReductor']);
			finalJSON['signatureModifiers'] = [{
				'signatureType' : getParam(result['item']['signatureReductor']['param'], 'type'),
				'factor' : getParam(result['item']['signatureReductor']['param'], 'factor'),
			}];
		}
		if (result['item']['armor'] != undefined) {
			var base = result['item']['armor'];
			if (base['signalMultipliers'] !== undefined && base['signalMultipliers']['multipliers'] !== undefined) {
				signatures = base['signalMultipliers']['multipliers'];
				finalJSON['signatureModifiers'] = [];
				for (var i = 0; i < signatures.length; i++) {
					finalJSON['signatureModifiers'].push({
						'signatureType' : signatures[i]['name'],
						'factor' : signatures[i]['value']
					});
				}
			}
			if (result['item']['armor']['damageMultipliers'] != undefined && result['item']['armor']['damageMultipliers']['damageMultiplier'] != undefined) {
				var base = result['item']['armor']['damageMultipliers']['damageMultiplier'];
				var multipliers = base.length === undefined ? [base] : base;
				finalJSON['damageMultipliers'] = []
				for (var i = 0; i < multipliers.length; i++) {
					finalJSON['damageMultipliers'].push({
						'damageType' : multipliers[i]['damageType'],
						'multiplierPhysical' : multipliers[i]['multiplier_physical'],
						'multiplierEnergy' : multipliers[i]['multiplier_energy'],
						'multiplierDistortion' : multipliers[i]['multiplier_distortion']
					});
				}
			}
		}
		if (result['item']['Pipes'] != undefined && result['item']['Pipes']['Pipe']) {
			finalJSON['pipes'] = [];
			var pipes = result['item']['Pipes']['Pipe'].length === undefined ? [result['item']['Pipes']['Pipe']] : result['item']['Pipes']['Pipe'];
			for (var i = 0; i < pipes.length; i++) {
				var pipe = {
					'pipeClass' : pipes[i]['class'],
					'prioType' : pipes[i]['prioType'],
					'prioGroup' : pipes[i]['prioGroup']
				};
				if (pipes[i]['Pool'] !== undefined) {
					pipe['pool'] = {
						'capacity' : pipes[i]['Pool']['capacity'],
						'rate' : pipes[i]['Pool']['rate'],
						'critical' : pipes[i]['Pool']['critical']
					};
				}
				if (pipes[i]['StateLevels'] != undefined) {
					pipe['stateLevels'] = {
						'warning' : pipes[i]['StateLevels']['Warning'] ? pipes[i]['StateLevels']['Warning']['value'] : undefined,
						'critical' : pipes[i]['StateLevels']['Critical'] ? pipes[i]['StateLevels']['Critical']['value'] : undefined,
						'fail' : pipes[i]['StateLevels']['Fail'] ? pipes[i]['StateLevels']['Fail']['value'] : undefined
					};
				}
				if (pipes[i]['States'] != undefined) {
					pipe['states'] = [];
					var states = pipes[i]['States']['State'].length === undefined ? [pipes[i]['States']['State']] : pipes[i]['States']['State'];
					for (var j = 0; j < states.length; j++) {
						var splitStates = states[j]['state'].split(',');
						for (var k = 0; k < splitStates.length; k++) {
							var state = {};
							state['state'] = splitStates[k].trim();
							state['transtion'] = states[j]['transition'];
							if (states[j]['Value'] != undefined) {
								state['values'] = [];
								var stateValues = states[j]['Value'].length === undefined ? [states[j]['Value']] : states[j]['Value'];
								for (var l = 0; l < stateValues.length; l++) {
									state['values'].push( {'value' : stateValues[l]['value'], 'delay' : stateValues[l]['delay'], 'ignorePool' : stateValues[l]['ignorepool']} )
								}
							}
							if (states[j]['Pipe'] != undefined) {
								state['variables'] = [];
								var stateValues = states[j]['Pipe'].length === undefined ? [states[j]['Pipe']] : states[j]['Pipe'];
								for (var l = 0; l < stateValues.length; l++) {
									state['variables'].push( {'value' : stateValues[l]['value'], 'name' : stateValues[l]['name']} )
								}
							}
							if (states[j]['Variable'] != undefined) {
								state['variables'] = [];
								var stateValues = states[j]['Variable'].length === undefined ? [states[j]['Variable']] : states[j]['Variable'];
								for (var l = 0; l < stateValues.length; l++) {
									state['variables'].push( {'value' : stateValues[l]['value'], 'name' : stateValues[l]['name'], 'ignorePool' : stateValues[l]['ignorepool']} )
								}
							}
							pipe['states'].push(state);
						}
					}
				}
				if (pipes[i]['Signature'] !== undefined) {
					pipe['signature'] = {
						'name' : pipes[i]['Signature']['name'],
						'multiplier' : pipes[i]['Signature']['multiplier'],
						'poolMultiplier' : pipes[i]['Signature']['poolMultiplier']
					};
				}
				finalJSON['pipes'].push(pipe);
			}
		}
		if (result['item']['portParams'] != undefined && result['item']['portParams']['ports'] != undefined) {
			// console.log(util.inspect(result['item']['portParams'], {depth : null}));
			finalJSON['itemPorts'] = [];
			var base = result['item']['portParams']['ports']['ItemPort'];
			var ports = base.length === undefined ? [base] : base;
			for (var i = 0; i < ports.length; i++) {
				var port = ports[i];
				var shouldAddPort = true;
				if (port !== undefined) {
					var ItemPort = {
						'name' : port['name'],
						'minSize' : Number(port['minsize']),
						'maxSize' : Number(port['maxsize'])
					}
					if (port['display_name'] != undefined) {
						ItemPort['displayName'] = port['display_name'];
					}
					if (port['flags'] != undefined) {
						ItemPort['flags'] = port['flags'].split(' ');
						if (ItemPort['flags'].some(hasIgnoredFlag)) shouldAddPort = false;
					}
					if (port['Pitch'] != undefined) {
						ItemPort['pitch'] = {
							'min' : Number(port['Pitch']['min']),
							'max' : Number(port['Pitch']['max'])
						}
						if (port['Pitch']['scale'] != undefined) {
							ItemPort['pitch']['scale'] = Number(port['Pitch']['scale']);
						}
					}
					if (port['Yaw'] != undefined) {
						ItemPort['yaw'] = {
							'min' : Number(port['Yaw']['min']),
							'max' : Number(port['Yaw']['max'])
						}
						if (port['Yaw']['scale'] != undefined) {
							ItemPort['yaw']['scale'] = Number(port['Yaw']['scale']);
						}
					}
					if (port['Roll'] != undefined) {
						ItemPort['roll'] = {
							'min' : Number(port['Roll']['min']),
							'max' : Number(port['Roll']['max'])
						}
						if (port['Roll']['scale'] != undefined) {
							ItemPort['roll']['scale'] = Number(port['Roll']['scale']);
						}
					}
					if (port['Types'] != undefined) {
						ItemPort['compatibleTypes'] = [];
						var types = port['Types']['Type'];
						if (types.length != undefined) {
							for (var j = 0; j < types.length; j++) {
								var type = { 'itemType' : types[j]['type'] };
								if (ignorePortTypes.indexOf(type.type) > -1) shouldAddPort = false;
								var subtype = types[j]['subtypes'];
								if (subtype != undefined) {
									subtype = subtype.split(',');
									if (subtype.length == 1) {
										if (subtype != '') {
											type['itemSubTypes'] = subtype;
										}
									}
									else {
										type['itemSubTypes'] = subtype;
									}
								}
								ItemPort['compatibleTypes'].push(type);
							}
						}
						else {
							var type = { 'itemType' : types['type'] };
							if (ignorePortTypes.indexOf(type.type) > -1) shouldAddPort = false;
							var subtype = types['subtypes'];
							if (subtype != undefined) {
								subtype = subtype.split(',');
								if (subtype.length == 1) {
									if (subtype != '') {
										type['itemSubTypes'] = subtype;
									}
								}
								else {
									type['itemSubTypes'] = subtype;
								}
							}
							ItemPort['compatibleTypes'].push(type);
						}
					}
					else shouldAddPort = false;
					if (shouldAddPort) {
						finalJSON['itemPorts'].push(ItemPort);
					}
				}
			}
		}
	});
	// console.log(util.inspect(finalJSON, {depth : null}));
    if (program.write) {
	    var outFilePath = path.join(program.output, itemName + '.json');
		fs.writeFile(outFilePath, JSON.stringify(finalJSON, null, 4), function(err) {
		    if(err) {
		      console.log(err);
		    }
		    console.log("Written to JSON " + outFilePath);
		}); 
    }
    if (program.submit) {
		console.log("Submitting " + program.api + 'items/name/' + finalJSON['name'])
		// Submit document to the API.  First determine if it exists or not.  If so do an update (PUT) otherwise submit a new document (POST)
		rest.get(program.api + 'items/name/' + finalJSON['name']).on('404', function(data, response) {
			// 404 response from the API means document was not found, so this doesn't already exist.  We need to create it with a POST
			console.warn('Existing ITEM ' + finalJSON['name'] + ' document not found -- POSTing a new document.')
			rest.postJson(program.api + 'items?api_key=971d43e3d3672cb54b8f28cd0b63d153', finalJSON).on('success', function(data, response) {
				console.warn("\tSuccessfully POSTed new document");
			}).on('error', function(err, response) {
					console.error('[ERROR] -- Received an unkown error while POSTing new ITEM ' + finalJSON['name'] + ' document')
					console.error(err);
					console.error(response);
			}).on('complete', function(result, response){
				ProcessNextFile();
			});
		}).on('success', function(data, response) {
			// Success response back means a document with this name is already in the databse, so we use PUT to simply update it with the new data
			console.warn('Existing ITEM ' + finalJSON['name'] + ' already exists -- PUTing an updated document.')
			rest.putJson(program.api + 'items?api_key=971d43e3d3672cb54b8f28cd0b63d153', finalJSON).on('success', function(data, response) {
				console.warn("\tSuccessfully PUT updated document");
			}).on('error', function(err, response){
				console.error("Error puting");
			}).on('complete', function(result, response){
				ProcessNextFile();
			});
		}).on('error', function(err, response) {
			// Something went wrong!
			console.error('[ERROR] -- Received an unkown error while checking to see if ITEM ' + finalJSON['name'] + ' exists')
			console.error(err);
			console.error(response);
		});
    }
};


function parseAmmo(doc, ammoName) {
	console.log("Parsing Ammo XML: " + ammoName);
    // Basic data
    var finalJSON = {};
    var ammo = xpath.select("//ammo", doc);
    var paramsRoot = null;
	parser.parseString(ammo, function (err, result) {
		finalJSON['name'] = ammoName;
		finalJSON['class'] = result['ammo']['class'];
		var splitName = ammoName.split("_");
		var shortCode = splitName[0].toLowerCase().trim();
		if (baseModel.manufactorCodes.indexOf(shortCode) > -1) {
			finalJSON['manufactorCode'] = shortCode;
		}
		else {
			// if we didn't find a match in the first part, try the second
			if (splitName.length >= 2) {
				shortCode = splitName[1].toLowerCase().trim();
				if (baseModel.manufactorCodes.indexOf(shortCode) > -1) {
					finalJSON['manufactorCode'] = shortCode;
				}
			}
		}
		if (finalJSON['manufactorCode'] === undefined) {
			// fallback to try and cross reference form the old method CIG used
			if (baseModel.oldManufactorPrefixMapping['shortCode'] !== undefined) {
				finalJSON['manufactorCode'] = baseModel.oldManufactorPrefixMapping['shortCode'];
			}
		}
		if (finalJSON['manufactorCode'] !== undefined) {
			var manufactor = baseModel.manufactorMapping[finalJSON['manufactorCode']];
			if (manufactor !== undefined) {
				finalJSON['manufactor'] = manufactor;
			}
		}

		if (result['ammo']['params'] != undefined && result['ammo']['params']['param'] != undefined) {
			var base = result['ammo']['params']['param'];
			finalJSON['params'] = {
				'itemType' : getParam(base, 'itemType'),
				'itemSubType' : getParam(base, 'itemSubType'),
				'itemDescription' : getParam(base, 'itemDescription'),
				'itemSize' : getParam(base, 'itemSize'),
				'displayName' : getParam(base, 'display_name'),
				'lifetime' : getParam(base, 'lifetime'),
				'mountable' : getParam(base, 'mountable'),
				'itemClass' : getParam(base, 'itemClass'),
				'itemTags' : getParam(base, 'itemTags'),
				'category' : getParam(base, 'category')
			};
			if (finalJSON['manufactor'] === undefined) {
				finalJSON['manufactor'] = getParam(base, 'itemManufactor');
			}
		}
		if (finalJSON['manufactor'] === undefined && finalJSON['manufactorCode'] !== undefined) {
			var manufactor = baseModel.manufactorMapping[finalJSON['manufactorCode']];
			if (manufactor !== undefined) {
				finalJSON['manufactor'] = manufactor;
			}
		}

		if (result['ammo']['physics'] !== undefined && result['ammo']['physics']['param'] != undefined) {
			var base = result['ammo']['physics']['param'];
			finalJSON['physics'] = {
				'mass' : getParam(base, 'mass'),
				'speed' : getParam(base, 'speed'),
				'radius' : getParam(base, 'radius'),
				'material' : getParam(base, 'material'),
				'pierceability' : getParam(base, 'pierceability')
			};
			base = result['ammo']['physics'];
			if (base['pierceabilityLevels'] != undefined && base['pierceabilityLevels']['param'] != undefined) {
				base = base['pierceabilityLevels']['param'];
				finalJSON['physics']['pierceabilityLevels'] = {
					'level1' : getParam(base, 'level1'),
					'level2' : getParam(base, 'level2'),
					'level3' : getParam(base, 'level3'),
					'maxPenetrationThickness' : getParam(base, 'maxPenetrationThickness')
				};
			}
		}

		if (result['ammo']['VehicleCountermeasure'] != undefined) {
			var base = result['ammo']['VehicleCountermeasure'];
			finalJSON['vehicleCountermeasure'] = {
				'signatureType' : getParam(base['param'], 'type')
			}
			if (base['interference'] != undefined) {
				finalJSON['vehicleCountermeasure']['signatures'] = [];
				var signatures = base['interference'].length === undefined ? [base['interference']] : base['interference'];
				console.log(signatures);
				for (var i = 0; i < signatures.length; i++) {
					var signature = {
						'signatureType' : signatures[i]['signature']['type']
					};
					console.log(signatures[i]);
					if (signatures[i]['param'] != undefined) {
						signature['radius'] = getParam(signatures[i]['param'], 'radius'),
						signature['strength'] = getParam(signatures[i]['param'], 'strength'),
						signature['startFadeTime'] = getParam(signatures[i]['param'], 'startFadeTime'),
						signature['endFadeTime'] = getParam(signatures[i]['param'], 'endFadeTime')
					}
					finalJSON['vehicleCountermeasure']['signatures'].push(signature);
				}
			}
			if (base['signature'] != undefined) {
				finalJSON['vehicleCountermeasure']['signatures'] = [];
				var signatures = base['signature'].length === undefined ? [base['signature']] : base['signature'];
				for (var i = 0; i < signatures.length; i++) {
					if (signatures[i]['param'] != undefined) {
						var signature = {
							'signatureType' : getParam(signatures[i]['param'], 'signatureType'),
							'amount' : getParam(signatures[i]['param'], 'amount'),
							'angleEffectiveness' : getParam(signatures[i]['param'], 'angleEffectiveness'),
							'signatureEffectiveness' : getParam(signatures[i]['param'], 'signatureEffectiveness')
						};
						finalJSON['vehicleCountermeasure']['signatures'].push(signature);
					}
				}
			}
		}

		if (result['ammo']['VehicleDamageParams'] != undefined && result['ammo']['VehicleDamageParams']['param'] != undefined) {
			finalJSON['VehicleDamageParams'] = {
				'damage' : getParam(result['ammo']['VehicleDamageParams']['param'], 'damage'),
				'damagePhysical' : getParam(result['ammo']['VehicleDamageParams']['param'], 'damage'),
				'damageEnergy' : getParam(result['ammo']['VehicleDamageParams']['param'], 'damage_energy'),
				'damageDistortion' : getParam(result['ammo']['VehicleDamageParams']['param'], 'damage_distortion'),
				'energyRateMul' : getParam(result['ammo']['VehicleDamageParams']['param'], 'energyRateMul')
			};
		}

		if (result['ammo']['explosion'] != undefined && result['ammo']['explosion']['param'] != undefined) {
			var base = result['ammo']['explosion']['param'];
			finalJSON['explosion'] = {
				'pressure' : getParam(base, 'pressure'),
				'maxRadius' : getParam(base, 'max_radius'),
				'damage' : getParam(base, 'damage'),
				'aiType' : getParam(base, 'aitype')
			};
		}

		if (result['ammo']['VehicleMissileGuidanceParams'] != undefined && result['ammo']['VehicleMissileGuidanceParams']['param'] != undefined) {
			var base = result['ammo']['VehicleMissileGuidanceParams']['param'];
			console.log(base);
			console.log(getParam(base, 'guidance_type'));
			finalJSON['vehicleMissileGuidanceParams'] = {
				'minTrackingAngle' : getParam(base, 'min_tracking_angle'),
				'maxTrackingAngle' : getParam(base, 'max_tracking_angle'),
				'minTrackingDistance' : getParam(base, 'min_tracking_distance'),
				'maxTrackingDistance' : getParam(base, 'max_tracking_distance'),
				'guidanceType' : getParam(base, 'guidance_type'),
				'signalRangeModifier' : getParam(base, 'signal_range_modifier'),
				'signatureName' : getParam(base, 'signature_name'),
				'signatureMultiplier' : getParam(base, 'signature_multiplier'),
				'signatureThreshold' : getParam(base, 'signature_threshold'),
				'signatureRangeMultiplier' : getParam(base, 'signature_range_multiplier')
			};
		}

		if (result['ammo']['VehicleMissileParams'] != undefined && result['ammo']['VehicleMissileParams']['param'] != undefined) {
			var base = result['ammo']['VehicleMissileParams']['param'];
			finalJSON['vehicleMissileParams'] = {
				'missileType' : getParam(base, 'category'),
				'maxSpeed' : getParam(base, 'max_speed'),
				'detonationProximity' : getParam(base, 'detonation_proximity'),
				'accel' : getParam(base, 'accel'),
				'turnSpeed' : getParam(base, 'turn_speed'),
				'initialDelay' : getParam(base, 'initial_delay')
			};
		}

	});
    if (program.write) {
	    var outFilePath = path.join(program.output, ammoName + '.json');
		fs.writeFile(outFilePath, JSON.stringify(finalJSON, null, 4), function(err) {
		    if(err) {
		      console.log(err);
		    }
		    console.log("Written to XML " + outFilePath);
		}); 
    }
    if (program.submit) {
		// Submit document to the API.  First determine if it exists or not.  If so do an update (PUT) otherwise submit a new document (POST)
		rest.get(program.api + 'ammo/name/' + finalJSON['name']).on('404', function(data, response) {
			// 404 response from the API means document was not found, so this doesn't already exist.  We need to create it with a POST
			console.log('Existing AMMO ' + finalJSON['name'] + ' document not found -- POSTing a new document.')
			rest.postJson(program.api + 'ammo?api_key=971d43e3d3672cb54b8f28cd0b63d153', finalJSON).on('success', function(data, response) {
				console.log("\tSuccessfully POSTed new document");
			}).on('error', function(err, response) {
					console.error('[ERROR] -- Received an unkown error while POSTing new AMMO ' + finalJSON['name'] + ' document')
					console.error(err);
					console.error(response);
			}).on('complete', function(result, response){
				ProcessNextFile();
			});
		}).on('success', function(data, response) {
			// Success response back means a document with this name is already in the databse, so we use PUT to simply update it with the new data
			console.log('Existing AMMO ' + finalJSON['name'] + ' already exists -- PUTing an updated document.')
			rest.putJson(program.api + 'ammo?api_key=971d43e3d3672cb54b8f28cd0b63d153', finalJSON).on('success', function(data, response) {
				console.log("\tSuccessfully PUT updated document");
			}).on('complete', function(result, response){
				ProcessNextFile();
			});
		}).on('error', function(err, response) {
			// Something went wrong!
			console.error('[ERROR] -- Received an unkown error while checking to see if AMMO ' + finalJSON['name'] + ' exists')
			console.error(err);
			console.error(response);
		});
    }
};

function parseMissile(doc, missileName) {
	console.log("Parsing Missile XML: " + missileName);
    // Basic data
    var finalJSON = {};
    var item = xpath.select("//item", doc);
    var paramsRoot = null;
	parser.parseString(item, function (err, result) {
		finalJSON['name'] = missileName;
		finalJSON['class'] = result['item']['class'];
		var splitName = missileName.split("_");
		var shortCode = splitName[0].toLowerCase().trim();
		if (baseModel.manufactorCodes.indexOf(shortCode) > -1) {
			finalJSON['manufactorCode'] = shortCode;
		}
		else {
			// if we didn't find a match in the first part, try the second
			if (splitName.length >= 2) {
				shortCode = splitName[1].toLowerCase().trim();
				if (baseModel.manufactorCodes.indexOf(shortCode) > -1) {
					finalJSON['manufactorCode'] = shortCode;
				}
			}
		}
		if (finalJSON['manufactorCode'] === undefined) {
			// fallback to try and cross reference form the old method CIG used
			if (baseModel.oldManufactorPrefixMapping['shortCode'] !== undefined) {
				finalJSON['manufactorCode'] = baseModel.oldManufactorPrefixMapping['shortCode'];
			}
		}
		if (finalJSON['manufactorCode'] !== undefined) {
			var manufactor = baseModel.manufactorMapping[finalJSON['manufactorCode']];
			if (manufactor !== undefined) {
				finalJSON['manufactor'] = manufactor;
			}
		}

		if (result['item']['params'] != undefined && result['item']['params']['param'] != undefined) {
			var base = result['item']['params']['param'];
			finalJSON['params'] = {
				'itemType' : getParam(base, 'itemType'),
				'itemSubType' : getParam(base, 'itemSubType'),
				'itemDescription' : getParam(base, 'itemDescription'),
				'itemSize' : getParam(base, 'itemSize'),
				'displayName' : getParam(base, 'display_name'),
				'mountable' : getParam(base, 'mountable'),
				'itemTags' : getParam(base, 'itemTags'),
				'mass' : getParam(base, 'mass')
			};
			if (finalJSON['manufactor'] === undefined) {
				finalJSON['manufactor'] = getParam(base, 'itemManufactor');
			}
		}
		if (finalJSON['manufactor'] === undefined && finalJSON['manufactorCode'] !== undefined) {
			var manufactor = baseModel.manufactorMapping[finalJSON['manufactorCode']];
			if (manufactor !== undefined) {
				finalJSON['manufactor'] = manufactor;
			}
		}
		// MISSILE
		if (result['item']['missile'] !== undefined && result['item']['missile']['param'] !== undefined) {
			var base = result['item']['missile']['param'];
			finalJSON['missileParams'] = {
				'guidanceType' : getParam(base, 'guidanceType'),
				'trackingSignalType' : getParam(base, 'trackingSignalType'),
				'trackingSignalAmplifier' : getParam(base, 'trackingSignalAmplifier'),
				'trackingDistanceMax' : getParam(base, 'trackingDistanceMax'),
				'trackingAngle' : getParam(base, 'trackingAngle'),
				'lockTime' : getParam(base, 'lockTime'),
				'lifetime' : getParam(base, 'lifetime'),
				'ignitiontime' : getParam(base, 'ignitiontime'),
				'maxSpeed' : getParam(base, 'maxSpeed'),
				'forwardAcceleration' : getParam(base, 'forwardAcceleration'),
				'reverseAcceleration' : getParam(base, 'reverseAcceleration'),
				'maneuverAcceleration' : getParam(base, 'maneuverAcceleration'),
				'rotationAcceleration' : getParam(base, 'rotationAcceleration'),
				'rotationThrottleAngle' : getParam(base, 'rotationThrottleAngle'),
				'explodeProximity' : getParam(base, 'explodeProximity'),
			};
			// CLUSTER
			if (result['item']['missile']['Cluster'] !== undefined && result['item']['missile']['Cluster']['param'] !== undefined) {
				base = result['item']['missile']['Cluster']['param'];
				finalJSON['cluster'] = {
					'triggerTargetDistance' : getParam(base, 'triggerTargetDistance'),	
					'triggerTargetAngle' : getParam(base, 'triggerTargetAngle'),	
					'ejectSpeed' : getParam(base, 'ejectSpeed')	
				};
				// ROCKETS
				if (result['item']['missile']['Cluster']['Rockets'] !== undefined && result['item']['missile']['Cluster']['Rockets']['param']) {
					finalJSON['cluster']['rockets'] = [];
					var rockets = result['item']['missile']['Cluster']['Rockets']['param'].length === undefined ? [result['item']['missile']['Cluster']['Rockets']['param']] : result['item']['missile']['Cluster']['Rockets']['param'];
					console.log(rockets);
					for (var i = 0; i < rockets.length; i++) {
						var rocket = {
							'rocketClass' : rockets[i]['rocketClass']
						};
						finalJSON['cluster']['rockets'].push(rocket);
					}
				}
			}
		}
		// EXPLOSION
		if (result['item']['explosion'] !== undefined && result['item']['explosion']['param'] !== undefined) {
			var base = result['item']['explosion']['param'];
			finalJSON['explosion'] = {
				'pressure' : getParam(base, 'pressure'),
				'maxRadius' : getParam(base, 'max_radius'),
				'damage' : getParam(base, 'damage'),
				'aiType' : getParam(base, 'aitype')
			};
		}
	});
    if (program.write) {
	    var outFilePath = path.join(program.output, missileName + '.json');
		fs.writeFile(outFilePath, JSON.stringify(finalJSON, null, 4), function(err) {
		    if(err) {
		      console.log(err);
		    }
		    console.log("Written to XML " + outFilePath);
		}); 
    }
    if (program.submit) {
		// Submit document to the API.  First determine if it exists or not.  If so do an update (PUT) otherwise submit a new document (POST)
		rest.get(program.api + 'missiles/name/' + finalJSON['name']).on('404', function(data, response) {
			// 404 response from the API means document was not found, so this doesn't already exist.  We need to create it with a POST
			console.log('Existing MISSILE ' + finalJSON['name'] + ' document not found -- POSTing a new document.')
			rest.postJson(program.api + 'missiles?api_key=971d43e3d3672cb54b8f28cd0b63d153', finalJSON).on('success', function(data, response) {
				console.log("\tSuccessfully POSTed new document");
			}).on('error', function(err, response) {
					console.error('[ERROR] -- Received an unkown error while POSTing new MISSILE ' + finalJSON['name'] + ' document')
					console.error(err);
					console.error(response);
			}).on('complete', function(result, response){
				ProcessNextFile();
			});
		}).on('success', function(data, response) {
			// Success response back means a document with this name is already in the databse, so we use PUT to simply update it with the new data
			console.log('Existing MISSILE ' + finalJSON['name'] + ' already exists -- PUTing an updated document.')
			rest.putJson(program.api + 'missiles?api_key=971d43e3d3672cb54b8f28cd0b63d153', finalJSON).on('success', function(data, response) {
				console.log("\tSuccessfully PUT updated document");
			}).on('error', function(err, response){
				console.error("Error puting");
			}).on('complete', function(result, response){
				ProcessNextFile();
			});
		}).on('error', function(err, response) {
			// Something went wrong!
			console.error('[ERROR] -- Received an unkown error while checking to see if MISSILE ' + finalJSON['name'] + ' exists')
			console.error(err);
			console.error(response);
		});
    }
};

if (program.submit)
{
	if (path.extname(program.input) != '') {
		fs.readFile(program.input, {encoding: 'utf8' }, function(err, data) {
			parseXML(null, data, program.input, null);
		});
	}
	else {
	dir.readFiles(program.input, {
		match: /.xml$/,
		exclude: /^\./
		}, function(err, content, next){next();},
		function(err, files){
			if (err) throw err;
			console.log('finished building file list');
			filesToParse = files;
			// Process first file to start things off
			var input = filesToParse.pop();
			fs.readFile(input, {encoding: 'utf8' }, function(err, data) {
				parseXML(null, data, input, null);
			});
		});	
	}
}
else
{
	if (path.extname(program.input) != '') {
		fs.readFile(program.input, {encoding: 'utf8' }, function(err, data) {
			parseXML(null, data, program.input, null);
		});
	}
	else {
	dir.readFiles(program.input, {
		match: /.xml$/,
		exclude: /^\./
		}, parseXML,
		function(err, files){
			if (err) throw err;
			console.log('finished reading files');
		});	
	}
}
	