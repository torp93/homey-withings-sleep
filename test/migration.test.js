'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const manifest = require('../app.json');
const deviceSource = fs.readFileSync(
  path.join(__dirname, '..', 'drivers', 'sleep_analyzer', 'device.js'), 'utf8'
);

/** The two lists the device reconciles on every start, read from the source. */
function capabilityLists() {
  const wanted = [...deviceSource.matchAll(/'(withings_[a-z_]+)'/g)]
    .map(m => m[1]);

  const retiredBlock = deviceSource.match(/const retired = \[([^\]]*)\]/);
  const retired = retiredBlock
    ? [...retiredBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1])
    : [];

  return { wanted, retired };
}

test('the retired list names the snoring capability', () => {
  const { retired } = capabilityLists();

  assert.deepStrictEqual(retired, ['withings_snoring']);
});

test('nothing is both wanted and retired', () => {
  // The hazard this guards: a capability in both lists would be removed and
  // added again on every single start, forever, and each pass writes to the
  // device. A future edit that revives a name must remove it from `retired`.
  const { retired } = capabilityLists();
  const driver = manifest.drivers.find(d => d.id === 'sleep_analyzer');

  for (const capability of retired) {
    assert.ok(
      !driver.capabilities.includes(capability),
      `${capability} is retired but still listed on the driver`
    );
    assert.ok(
      !(capability in manifest.capabilities),
      `${capability} is retired but still defined in the manifest`
    );
  }
});

test('every capability the driver lists is defined in the manifest', () => {
  const driver = manifest.drivers.find(d => d.id === 'sleep_analyzer');

  for (const capability of driver.capabilities) {
    assert.ok(
      capability in manifest.capabilities,
      `${capability} is on the driver but has no definition`
    );
  }
});

test('the sleep summary trigger keeps its id and its remaining tokens', () => {
  // Removing the token changed the card's shape. The id must not change too,
  // or every existing Flow using the card breaks rather than just the tag.
  const trigger = manifest.flow.triggers.find(t => t.id === 'withings_summary_ready');

  assert.ok(trigger, 'the trigger still exists');
  assert.deepStrictEqual(
    trigger.tokens.map(t => t.name),
    ['minutes', 'readable', 'score', 'heart_rate', 'breathing_rate']
  );
});
