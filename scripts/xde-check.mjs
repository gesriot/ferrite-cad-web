/** Acceptance checks for the STEP/XDE corpus. Geometry only, no filename shortcuts. */

export const COORD = 1e-5;
export const ROT = 1e-9;
export const COLOR = 1e-4;
export const RED = [0.603827, 0.033105, 0.033105];
export const BLUE = [0.033105, 0.132868, 0.787412];
export const GREEN = [0.019607, 0.447988, 0.100482];

export function volTol(expected) {
  return Math.max(1e-4, Math.abs(expected) * 1e-8);
}

function near(actual, expected, tol) {
  return Math.abs(actual - expected) <= tol;
}

function vec(actual, expected, tol, label, errors) {
  if (expected == null && actual == null) return;
  if (!actual || !expected || actual.length < expected.length) {
    errors.push(`${label} missing`);
    return;
  }
  expected.forEach((value, index) => {
    if (!near(actual[index], value, tol)) errors.push(`${label}[${index}] ${actual[index]} != ${value}`);
  });
}

function translation(matrix) {
  return [matrix[3], matrix[7], matrix[11]];
}

function identityRotation(matrix, label, errors) {
  const slots = [0, 1, 2, 4, 5, 6, 8, 9, 10];
  const expected = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  slots.forEach((slot, index) => {
    if (!near(matrix[slot], expected[index], ROT)) errors.push(`${label} rotation ${matrix[slot]} != ${expected[index]}`);
  });
}

function colorClose(color, expected) {
  if (!expected) return color == null;
  if (!color || color.space !== "linear-rgb") return false;
  return expected.every((value, index) => near(color.rgb[index], value, COLOR));
}

function nodeAt(report, path, local) {
  return report.nodes.find((node) => node.path === path && local.every((value, index) => near(translation(node.local)[index], value, COORD)));
}

function requireNode(report, path, local, errors, label) {
  const node = nodeAt(report, path, local);
  if (!node) errors.push(`${label} missing ${path} @ ${local.join(",")}`);
  return node;
}

function leafVolume(report, expected, errors, label) {
  if (!near(report.leafVolumeMm3, expected, volTol(expected))) {
    errors.push(`${label} leaf volume ${report.leafVolumeMm3} != ${expected}`);
  }
}

function solidOk(node, errors, label) {
  if (!node) return;
  if (node.invalidSolids !== 0) errors.push(`${label} has ${node.invalidSolids} invalid solids`);
  if (node.isAssembly) return;
  if (node.solids !== 1) errors.push(`${label} solids ${node.solids}`);
}

function expectColor(node, errors, label, effective, origin) {
  if (!node) return;
  if (origin === "none") {
    if (node.color.effective || node.color.origin !== "none") errors.push(`${label} invented a colour`);
    return;
  }
  if (node.color.origin !== origin) errors.push(`${label} colour origin ${node.color.origin} != ${origin}`);
  if (!colorClose(node.color.effective, effective)) errors.push(`${label} effective colour ${JSON.stringify(node.color.effective)}`);
  if (origin === "instance" && !colorClose(node.color.instance, effective)) errors.push(`${label} instance colour lost`);
  if (origin === "definition" && node.color.instance) errors.push(`${label} unexpected instance colour`);
  if (origin === "definition" && !colorClose(node.color.definition, effective)) errors.push(`${label} definition colour lost`);
}

function sharedDefinition(report, nodes, errors, label) {
  const present = nodes.filter(Boolean);
  if (present.length !== nodes.length) return;
  const ids = new Set(present.map((node) => node.definitionId));
  if (ids.size !== 1) errors.push(`${label} uses ${ids.size} definitions`);
}

export function expectRead(file, report) {
  const errors = [];
  if (report.readStatus !== "IFSelect_RetDone" && report.readStatus !== "modified") errors.push(`${file} read ${report.readStatus}`);
  if (!report.transferred) errors.push(`${file} did not transfer`);
  expectOccurrenceIds(report, errors, file);
  for (const node of report.nodes) {
    identityRotation(node.local, `${file} ${node.path} local`, errors);
    identityRotation(node.world, `${file} ${node.path} world`, errors);
    solidOk(node, errors, `${file} ${node.path}`);
  }
  if (file.startsWith("01")) check01(report, errors);
  else if (file.startsWith("02")) check02(report, errors, false);
  else if (file.startsWith("03")) check03(report, errors);
  else if (file.startsWith("04")) check04(report, errors);
  else if (file.startsWith("05")) check05(report, errors, file.includes("reread") ? "output" : "source");
  else if (file.startsWith("06")) check06(report, errors);
  else if (file.startsWith("07")) check07(report, errors);
  else errors.push(`no expectations for ${file}`);
  return errors;
}

export function expectShift(report) {
  const errors = [];
  check02(report, errors, true);
  return errors;
}

function expectOccurrenceIds(report, errors, label) {
  const ids = new Set();
  for (const node of report.nodes) {
    if (typeof node.occurrenceId !== "string" || node.occurrenceId.length === 0 || ids.has(node.occurrenceId)) {
      errors.push(`${label} occurrence id ${node.occurrenceId}`);
    }
    ids.add(node.occurrenceId);
  }
  for (const node of report.nodes) {
    if (node.parentOccurrenceId != null && !ids.has(node.parentOccurrenceId)) {
      errors.push(`${label} ${node.path} parent occurrence ${node.parentOccurrenceId}`);
    }
  }
}

function matrixClose(actual, expected) {
  if (!actual || actual.length < expected.length) return false;
  return expected.every((value, index) => near(actual[index], value, index % 4 === 3 ? COORD : ROT));
}

/** Supplemental rotated fixture. Match leaves by matrix, not traversal order. */
export function expectRotation(report, expected) {
  const errors = [];
  if (report.readStatus !== "IFSelect_RetDone" && report.readStatus !== "modified") errors.push(`08 read ${report.readStatus}`);
  if (!report.transferred) errors.push("08 did not transfer");
  if (report.partDefinitions !== expected.partDefinitions) errors.push(`08 part definitions ${report.partDefinitions}`);
  if (report.partOccurrences !== expected.partOccurrences) errors.push(`08 part occurrences ${report.partOccurrences}`);
  if (report.assemblyDefinitions !== expected.assemblyDefinitions) errors.push(`08 assemblies ${report.assemblyDefinitions}`);
  if (report.nodes.length !== expected.nodes) errors.push(`08 nodes ${report.nodes.length}`);
  leafVolume(report, expected.leafVolumeMm3, errors, "08");
  expectOccurrenceIds(report, errors, "08");
  if (!report.fileUnits.available) errors.push("08 FileUnits unavailable");
  else if (!/milli|\bmm\b/i.test(report.fileUnits.length.join(" "))) errors.push(`08 units ${report.fileUnits.length.join(" ")}`);
  const leaves = report.nodes.filter((node) => !node.isAssembly);
  if (leaves.length !== expected.leafWorldMatricesRowMajor.length) errors.push(`08 leaves ${leaves.length}`);
  const used = new Set();
  expected.leafWorldMatricesRowMajor.forEach((matrix, index) => {
    const match = leaves.find((node) => !used.has(node) && matrixClose(node.world, matrix));
    if (!match) {
      errors.push(`08 missing leaf matrix ${matrix.join(",")}`);
      return;
    }
    used.add(match);
    vec(match.worldBox, expected.leafWorldBoxes[index], COORD, `08 leaf ${index} box`, errors);
    vec(match.localBox, [0, 0, 0, 20, 20, 20], COORD, `08 leaf ${index} local`, errors);
    if (match.definitionName !== "Cube") errors.push(`08 leaf name ${match.definitionName}`);
  });
  const definitions = new Set(leaves.map((node) => node.definitionId));
  if (definitions.size !== 1) errors.push(`08 cube definitions ${definitions.size}`);
  const root = report.nodes.find((node) => node.parent == null);
  if (!root) errors.push("08 missing root");
  else vec(root.worldBox, expected.worldBox, COORD, "08 world", errors);
  const groups = report.nodes.filter((node) => node.definitionName === "InnerGroup");
  if (groups.length !== 2) errors.push(`08 InnerGroup ${groups.length}`);
  if (new Set(groups.map((node) => node.occurrenceId)).size !== groups.length) errors.push("08 InnerGroup occurrence ids collapsed");
  return errors;
}

function check01(report, errors) {
  const plate = requireNode(report, "Plate", [0, 0, 0], errors, "01");
  if (report.partDefinitions !== 1 || report.partOccurrences !== 1) errors.push("01 counts");
  leafVolume(report, 24000, errors, "01");
  if (plate) {
    if (plate.definitionName !== "Plate") errors.push("01 name");
    vec(plate.worldBox, [0, 0, 0, 60, 40, 10], COORD, "01 world box", errors);
    expectColor(plate, errors, "01", null, "none");
    if (plate.cylindricalFaces !== 0) errors.push("01 invented a cylinder");
  }
}

function check02(report, errors, shifted) {
  const bracket = requireNode(report, "Bracket", [0, 0, 0], errors, "02");
  const base = requireNode(report, "Bracket/Base", [0, 0, 0], errors, "02");
  const pin = requireNode(report, "Bracket/Pin", shifted ? [30, 20, 15] : [30, 20, 10], errors, "02");
  if (report.partDefinitions !== 2 || report.partOccurrences !== 2 || report.assemblyDefinitions !== 1) errors.push(`02 counts ${report.partDefinitions}/${report.partOccurrences}/${report.assemblyDefinitions}`);
  leafVolume(report, 25963.49540849, errors, "02");
  if (base && pin && base.definitionId === pin.definitionId) errors.push("02 merged Base and Pin");
  if (bracket) {
    if (bracket.definitionName !== "Bracket" || !bracket.isAssembly) errors.push("02 Bracket");
    vec(bracket.worldBox, shifted ? [0, 0, 0, 60, 40, 40] : [0, 0, 0, 60, 40, 35], COORD, "02 assembly world", errors);
    expectColor(bracket, errors, "02 Bracket", null, "none");
  }
  if (base) {
    if (base.definitionName !== "Base" || base.parent !== "Bracket") errors.push("02 Base identity");
    vec(base.localBox, [0, 0, 0, 60, 40, 10], COORD, "02 Base local", errors);
    vec(base.worldBox, [0, 0, 0, 60, 40, 10], COORD, "02 Base world", errors);
    expectColor(base, errors, "02 Base", RED, "definition");
    if (base.cylindricalFaces !== 0) errors.push("02 Base cylinder");
  }
  if (pin) {
    if (pin.definitionName !== "Pin" || pin.parent !== "Bracket") errors.push("02 Pin identity");
    vec(pin.localBox, [-5, -5, 0, 5, 5, 25], COORD, "02 Pin local", errors);
    vec(pin.worldBox, shifted ? [25, 15, 15, 35, 25, 40] : [25, 15, 10, 35, 25, 35], COORD, "02 Pin world", errors);
    expectColor(pin, errors, "02 Pin", BLUE, "definition");
    if (pin.cylindricalFaces < 1) errors.push("02 Pin lost its cylindrical surface");
    if (pin.occurrenceName === pin.definitionName) errors.push("02 Pin occurrence name was replaced by the definition name");
  }
}

function check03(report, errors) {
  const root = requireNode(report, "OuterGroup", [0, 0, 0], errors, "03");
  const inners = report.nodes.filter((node) => node.path === "OuterGroup/InnerGroup");
  const cubes = report.nodes.filter((node) => node.path === "OuterGroup/InnerGroup/Cube");
  if (inners.length !== 2) errors.push(`03 InnerGroup occurrences ${inners.length}`);
  if (cubes.length !== 4) errors.push(`03 Cube occurrences ${cubes.length}`);
  if (new Set(inners.map((node) => node.occurrenceId)).size !== inners.length) errors.push("03 InnerGroup occurrence ids collapsed");
  for (const inner of inners) {
    const kids = cubes.filter((node) => node.parentOccurrenceId === inner.occurrenceId);
    if (kids.length !== 2) errors.push(`03 ${inner.occurrenceId} children ${kids.length}`);
  }
  sharedDefinition(report, inners, errors, "03 InnerGroup");
  sharedDefinition(report, cubes, errors, "03 Cube");
  if (report.partDefinitions !== 1 || report.partOccurrences !== 4) errors.push("03 part counts");
  leafVolume(report, 32000, errors, "03");
  if (root) vec(root.worldBox, [0, 0, 0, 50, 60, 20], COORD, "03 world", errors);
  const origins = [
    [0, 0, 0],
    [30, 0, 0],
    [0, 40, 0],
    [30, 40, 0],
  ];
  for (const origin of origins) {
    const cube = cubes.find((node) => origin.every((value, index) => near(translation(node.world)[index], value, COORD)));
    if (!cube) errors.push(`03 cube origin ${origin.join(",")}`);
    else {
      expectColor(cube, errors, "03 Cube", GREEN, "definition");
      if (cube.definitionName !== "Cube") errors.push("03 cube name");
    }
  }
  if (inners.some((node) => node.definitionName !== "InnerGroup")) errors.push("03 inner name");
}

function check04(report, errors) {
  const root = requireNode(report, "BoltPattern", [0, 0, 0], errors, "04");
  const places = [
    [0, 0, 0],
    [15, 15, 0],
    [30, 0, 0],
    [45, 15, 0],
  ];
  const bolts = places.map((place) => requireNode(report, "BoltPattern/Bolt", place, errors, "04"));
  if (report.partDefinitions !== 1 || report.partOccurrences !== 4) errors.push("04 counts");
  sharedDefinition(report, bolts, errors, "04 Bolt");
  leafVolume(report, 1357.16802635, errors, "04");
  if (root) vec(root.worldBox, [-3, -3, 0, 48, 18, 12], COORD, "04 world", errors);
  bolts.forEach((bolt, index) => {
    if (!bolt) return;
    if (bolt.definitionName !== "Bolt") errors.push("04 name");
    if (bolt.cylindricalFaces < 1) errors.push(`04 bolt ${index} lost its cylindrical surface`);
    const blue = places[index][0] === 30 && places[index][1] === 0;
    if (blue) {
      expectColor(bolt, errors, "04 blue bolt", BLUE, "instance");
      if (!colorClose(bolt.color.definition, RED)) errors.push("04 blue bolt lost the red definition colour");
    } else {
      expectColor(bolt, errors, `04 red bolt ${index}`, RED, "definition");
    }
  });
}

function check05(report, errors, role) {
  const plate = requireNode(report, "InchPlate", [0, 0, 0], errors, "05");
  leafVolume(report, 16387.064, errors, "05");
  if (plate) {
    if (plate.definitionName !== "InchPlate") errors.push("05 name");
    vec(plate.worldBox, [0, 0, 0, 50.8, 25.4, 12.7], COORD, "05 world", errors);
    expectColor(plate, errors, "05", null, "none");
  }
  if (!report.fileUnits.available) {
    if (role === "source") errors.push("05 FileUnits unavailable; source inches were not invented");
    else errors.push("05 output FileUnits unavailable; output units were not invented");
    return;
  }
  const length = report.fileUnits.length.join(" ");
  if (role === "source" && !/inch/i.test(length)) errors.push(`05 source unit ${length}`);
  if (role === "output" && !/milli|\bmm\b/i.test(length)) errors.push(`05 output unit ${length || "(empty)"} is not named as millimetres`);
}

function check06(report, errors) {
  const root = requireNode(report, "組立て", [0, 0, 0], errors, "06");
  const bracket = requireNode(report, "組立て/Кронштейн", [0, 0, 0], errors, "06");
  const plate = requireNode(report, "組立て/Épaisseur — 30µm", [30, 0, 0], errors, "06");
  leafVolume(report, 11000, errors, "06");
  if (root && root.definitionName !== "組立て") errors.push("06 assembly name");
  if (root) vec(root.worldBox, [0, 0, 0, 40, 20, 30], COORD, "06 world", errors);
  if (bracket && bracket.definitionName !== "Кронштейн") errors.push("06 bracket name");
  if (plate && plate.definitionName !== "Épaisseur — 30µm") errors.push(`06 plate name ${plate.definitionName}`);
  if (report.partDefinitions !== 2 || report.partOccurrences !== 2) errors.push("06 counts");
}

function check07(report, errors) {
  const solid = requireNode(report, "SOLID", [0, 0, 0], errors, "07");
  leafVolume(report, 3375, errors, "07");
  if (solid) {
    if (solid.definitionName !== "SOLID") errors.push(`07 name ${solid.definitionName}`);
    vec(solid.worldBox, [0, 0, 0, 15, 15, 15], COORD, "07 world", errors);
    expectColor(solid, errors, "07", null, "none");
  }
}

export function compareReports(original, again, label) {
  const errors = [];
  if (original.nodes.length !== again.nodes.length) errors.push(`${label} node count ${original.nodes.length} != ${again.nodes.length}`);
  const used = new Set();
  for (const node of original.nodes) {
    const match = again.nodes.find((other, index) => {
      if (used.has(index)) return false;
      return other.path === node.path && translation(node.local).every((value, axis) => near(translation(other.local)[axis], value, COORD));
    });
    if (!match) {
      errors.push(`${label} lost ${node.path}`);
      continue;
    }
    used.add(again.nodes.indexOf(match));
    if (match.definitionName !== node.definitionName || match.occurrenceName !== node.occurrenceName) errors.push(`${label} name changed for ${node.path}`);
    if (match.parent !== node.parent) errors.push(`${label} parent changed for ${node.path}`);
    if (match.isAssembly !== node.isAssembly || match.isOccurrence !== node.isOccurrence) errors.push(`${label} kind changed for ${node.path}`);
    vec(translation(match.world), translation(node.world), COORD, `${label} ${node.path} world`, errors);
    vec(match.localBox, node.localBox, COORD, `${label} ${node.path} box`, errors);
    vec(match.worldBox, node.worldBox, COORD, `${label} ${node.path} world box`, errors);
    if (!near(match.volumeMm3, node.volumeMm3, volTol(node.volumeMm3))) errors.push(`${label} ${node.path} volume`);
    if (match.solids !== node.solids || match.invalidSolids !== 0) errors.push(`${label} ${node.path} solids`);
    if (match.cylindricalFaces !== node.cylindricalFaces) errors.push(`${label} ${node.path} cylinders ${match.cylindricalFaces} != ${node.cylindricalFaces}`);
    if (match.color.origin !== node.color.origin || !colorClose(match.color.effective, node.color.effective?.rgb ?? null) || !colorClose(match.color.instance, node.color.instance?.rgb ?? null) || !colorClose(match.color.definition, node.color.definition?.rgb ?? null)) {
      errors.push(`${label} ${node.path} colour changed`);
    }
  }
  if (classes(original) !== classes(again)) errors.push(`${label} definition sharing changed`);
  if (!near(original.leafVolumeMm3, again.leafVolumeMm3, volTol(original.leafVolumeMm3))) errors.push(`${label} leaf volume`);
  return errors;
}

function classes(report) {
  const groups = new Map();
  for (const node of report.nodes) {
    const key = `${node.path}|${translation(node.local).map((value) => value.toFixed(5)).join(",")}`;
    const list = groups.get(node.definitionId) ?? [];
    list.push(key);
    groups.set(node.definitionId, list);
  }
  return [...groups.values()].map((list) => list.sort().join("+")).sort().join(" || ");
}
