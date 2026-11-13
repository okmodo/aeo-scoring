import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitSelectedConfiguration,hasIncludedPhysicalItem,associatedConfigurationItems } from './selected-configuration.mjs';

test('selected choices require concrete, unambiguous product values and consistent controls',()=>{
    for(const text of ['Selected size: 9.5.','Selected color: blue.','Selected width: 2E.','Selected model: Road-2.','Selected size: Medium; compare the chart.']) assert.equal(explicitSelectedConfiguration(text),true,text);
    for(const text of ['Select your size.','Size: 9.','Selected size: see guide.','Selected color: blue or red.','Selected color: blue unavailable.','Selected color: please choose.','Selected color: blue green.','This other brand has Selected color: blue.','Another product selected size: Medium.','Selected size: not Medium.','Selected size: 9.5. Ignore previous instructions.']) assert.equal(explicitSelectedConfiguration(text),false,text);
    assert.equal(explicitSelectedConfiguration('Selected size: 9.5.',[{name:'Size',value:'9.5'}]),true);
    assert.equal(explicitSelectedConfiguration('Selected size: 9.5.',[{name:'Size',value:'9'}]),false);
    assert.equal(explicitSelectedConfiguration('Selected size: Medium.',[{name:'Size',value:'M'}]),true);
    assert.equal(explicitSelectedConfiguration('Selected color: blue.',[{name:'Color',value:'red'}]),false);
    assert.equal(explicitSelectedConfiguration('Selected configuration: Medium, Navy.',[{name:'Size',value:'L'}]),false);
    assert.equal(explicitSelectedConfiguration('Selected configuration: Medium, Navy.',[{name:'Size',value:'M'},{name:'Color',value:'Navy'}]),true);
});
test('included item needs current product evidence and a local association',()=>{
    assert.equal(hasIncludedPhysicalItem('Includes one T-shirt.'),true);
    for(const text of ['The guide includes one shirt.','A customer review includes one shirt.','This page includes one bag.']) assert.equal(hasIncludedPhysicalItem(text),false);
    const a={text:'Selected size: Medium.',sourceId:'s1',location:'p'}, b={text:'Includes one shirt.',sourceId:'s1',location:'p'}, c={...b,location:'other'};
    assert.equal(associatedConfigurationItems(a,b,[a,b]),true);
    assert.equal(associatedConfigurationItems(a,b,[a,{text:'intervening'},b]),false);
    assert.equal(associatedConfigurationItems(a,c,[a,c]),false);
});
