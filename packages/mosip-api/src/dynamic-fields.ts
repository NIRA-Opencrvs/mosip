import { readFileSync } from "fs";
import path from "path";

// Load the dynamic fields dataset once at module initialization
const DYN_FIELDS_PATH = path.resolve(__dirname, '../../..', 'dynamic_fields_dataset.json');

type DynamicFieldsDataset = Array<{ name: string; fieldVal: Array<{ code: string; value: string }> }>;

let dynamicFieldsDataset: DynamicFieldsDataset = [];
try {
  dynamicFieldsDataset = JSON.parse(readFileSync(DYN_FIELDS_PATH, 'utf8'));
  console.log(`[Dynamic Fields] Loaded ${dynamicFieldsDataset.length} fields from ${DYN_FIELDS_PATH}`);
} catch (e) {
  console.warn(`[Dynamic Fields] Could not load dataset from ${DYN_FIELDS_PATH}:`, (e as Error).message);
}

// Create a map for quick lookup: fieldName -> { valueToCode map }
// This is created ONCE when the module is loaded
const dynamicFieldsMap = new Map<string, Map<string, string>>();

for (const field of dynamicFieldsDataset) {
  const valueToCodeMap = new Map<string, string>();
  for (const fv of field.fieldVal) {
    // Store both exact value and lowercase for flexible matching
    valueToCodeMap.set(fv.value, fv.code);
    valueToCodeMap.set(fv.value.toLowerCase(), fv.code);
  }
  dynamicFieldsMap.set(field.name, valueToCodeMap);
  dynamicFieldsMap.set(field.name.toLowerCase(), valueToCodeMap);
}

console.log(`[Dynamic Fields] Map created with ${dynamicFieldsMap.size / 2} unique field names`);

/**
 * Check if a field is a dynamic field (exists in dynamic_fields_dataset.json)
 */
export const isDynamicField = (fieldName: string): boolean => {
  return dynamicFieldsMap.has(fieldName) || dynamicFieldsMap.has(fieldName.toLowerCase());
};

/**
 * Find the code for a given field name and value.
 * @param fieldName - The field name to look up (e.g., "gender", "residenceStatus")
 * @param label - The value/label to find the code for (e.g., "Male", "In Uganda")
 * @returns The code if found, otherwise the original label
 */
export const findCodeForFieldValue = (fieldName: string, label?: string | null): string | undefined => {
  if (!label) return undefined;

  const needle = String(label).trim();
  const needleLower = needle.toLowerCase();

  const valueToCodeMap = dynamicFieldsMap.get(fieldName) || dynamicFieldsMap.get(fieldName.toLowerCase());

  if (valueToCodeMap) {
    if (valueToCodeMap.has(needle)) {
      return valueToCodeMap.get(needle);
    }
    if (valueToCodeMap.has(needleLower)) {
      return valueToCodeMap.get(needleLower);
    }
  }

  // Field not found in dataset, return original value
  return needle;
};

/**
 * Extract the first string value from various formats (lang array, plain string, etc.)
 */
export const pickFirstString = (value: any): string | undefined => {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed[0].value ?? parsed[0];
        if (parsed && typeof parsed === 'object') return (parsed.value ?? Object.values(parsed)[0]) as string;
      } catch (_) {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value) && value.length > 0) return value[0].value ?? value[0];
  if (typeof value === 'object') return (value.value ?? Object.values(value)[0]) as string;
  return String(value);
};

/**
 * Check if the raw value is a JSON lang array string like '[{"language":"eng","value":"..."}]'
 */
export const isLangArrayString = (value: any): boolean => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('[{"language"') || trimmed.startsWith('[{\"language\"');
};
