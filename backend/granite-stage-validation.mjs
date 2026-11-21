// JSON shape checks only. Source membership, completeness and credit are checked
// by the retained assessment validators after these boundaries.
const str = {type:'string'};
const bool = {type:'boolean'};
const nullable = schema => ({anyOf:[schema,{type:'null'}]});
const array = items => ({type:'array',items});
const object = (properties, required = Object.keys(properties)) => ({type:'object',properties,required});
const enumeration = (...values) => ({enum:values});
const ref = object({sourceId:str,quote:str,fieldPath:array({anyOf:[str,{type:'integer',minimum:0}]}),value:{anyOf:[str,{type:'number'},bool]}},['sourceId']);
// A reference may cite an exact quotation or a structured field and value.
ref.anyOf = [{required:['quote']},{required:['fieldPath','value']}];
const evidence = array(ref);
const status = enumeration('present','absent','unknown');
const check = object({id:str,status,evidence});
const inspection = object({sourceId:str,checks:array(check),conditions:array(check),claimsComplete:bool,comparisonsComplete:bool,claims:array(object({quote:str})),comparisons:array(object({field:str,context:str,quote:str}))},['sourceId','checks','claimsComplete','comparisonsComplete','claims','comparisons']);
const support = object({sourceId:str,claims:array(object({id:str,status,evidence,references:array(object({quote:str,target:nullable(str)}))}))});
const batch = section => object({sections:array(section)});
const fraction = enumeration(0,0.5,1,null);
const judgmentStatus = enumeration('measured','not_measured','not_applicable');
const judgment = object({id:str,status:judgmentStatus,fraction,reason:str,rule:nullable(enumeration('category_conditions_absent','no_material_claims')),basis:nullable(enumeration('absence','generic','contradiction')),comparisonContext:nullable(str),comparisonValue:nullable(str),evidence,inspectedSourceIds:array(str)},['id','status','fraction','reason','evidence']);
const claim = object({id:str,status:judgmentStatus,fraction,reason:str,evidence});
const comparison = object({candidateIds:array(str),status:judgmentStatus,fraction,reason:str,context:str,value:nullable(str)},['candidateIds','status','fraction','reason','context']);
const slot = object({id:str,group:enumeration('C2.essential','C2.supporting','C4.intended-use','C4.compatibility','C4.limitations','C4.selection'),label:str,relevance:str,full:str,partial:str,zero:str,missingExpectation:str,applicability:enumeration('always','conditional'),condition:nullable(str),conditionWhy:nullable(str)},['id','group','label','relevance','full','partial','zero','missingExpectation']);
const schemas = {
  extraction:object({evidence,primaryEvidence:evidence},['evidence']),
  category:object({status:enumeration('classified','ambiguous'),category:nullable(str),evidence}),
  profile:object({slots:array(slot)}),
  conditions:object({conditions:array(object({id:str,valid:bool,reason:str}))}),
  inspection:batch(inspection),
  support:batch(support),
  judgment:object({judgments:array(judgment),c5:object({claims:array(claim),comparisons:array(comparison)})})
};

function matches(schema, value) {
  if (schema.anyOf && !schema.anyOf.some(candidate=>matches(candidate,value))) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null' && value !== null) return false;
  if (schema.type === 'string' && typeof value !== 'string') return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || (schema.minimum !== undefined && value < schema.minimum))) return false;
  if (schema.type === 'array' && (!Array.isArray(value) || !value.every(item=>matches(schema.items,item)))) return false;
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return false;
  if (schema.required && (!value || typeof value !== 'object' || schema.required.some(key=>!Object.hasOwn(value,key)))) return false;
  if (schema.properties && Object.entries(schema.properties).some(([key,child])=>Object.hasOwn(value,key) && !matches(child,value[key]))) return false;
  return true;
}
export function validateGraniteStage(stage, output) {
  if (!Object.hasOwn(schemas,stage) || !matches(schemas[stage],output)) throw new Error('model_output_invalid');
  return output;
}
