import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTelemetry, validCpu } from './telemetry.mjs';
test('telemetry retains only recognized primary CPU and request path', () => {
  const filtered=filterTelemetry({cpuTime:466,event:{request:{url:'https://example.test/control?secret=x',headers:{authorization:'secret'},cf:{cpuTime:2}}},logs:['secret']});
  assert.deepEqual(filtered,{cpuMs:466,path:'/control'});
  assert.equal(validCpu(filtered,1000),true);
  assert.equal(validCpu({cpuMs:1001},1000),false);
  assert.equal(validCpu(filterTelemetry({event:{cpuTime:2}})),false);
});
