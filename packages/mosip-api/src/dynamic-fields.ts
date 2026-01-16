import { readFileSync } from "fs";
import * as path from "path";

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

// Load the location data dataset once at module initialization
const LOCATION_DATA_PATH = path.resolve(__dirname, '../../..', 'location_data.json');

type LocationDataset = Array<{ 
  name: string; 
  fieldVal: Array<{ 
    code: string; 
    value: string; 
    parent_loc_code: string; 
  }> 
}>;

let locationDataset: LocationDataset = [];
try {
  locationDataset = JSON.parse(readFileSync(LOCATION_DATA_PATH, 'utf8'));
  console.log(`[Location Data] Loaded ${locationDataset.length} location types from ${LOCATION_DATA_PATH}`);
} catch (e) {
  console.warn(`[Location Data] Could not load dataset from ${LOCATION_DATA_PATH}:`, (e as Error).message);
}

/**
 * Load location data from the cached dataset
 * @returns The location data
 */
export const loadLocationData = (): LocationDataset => {
  return locationDataset;
};

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

/**
 * Get location hierarchy codes from local JSON data using village name
 * @param locationName - Name to search for
 * @param locationType - Type of location (Village, Parish, SubCounty, County, District)
 * @param locationData - The loaded location data
 * @returns The location object if found
 */
const findLocationByName = (locationName: string, locationType: string, locationData: any[]): any => {
  const locationTypeData = locationData.find(item => item.name === locationType);
  if (!locationTypeData) return null;
  
  // Normalize the search name for better matching
  const normalizedSearchName = locationName.toUpperCase().replace(/\s+/g, '');
  
  // Try exact match first
  let match = locationTypeData.fieldVal.find((loc: any) => 
    loc.value.toUpperCase().includes(locationName.toUpperCase())
  );
  
  // If no exact match, try more sophisticated matching for common variations
  if (!match && locationType === 'Village') {
    // For villages, look for candidates that contain key parts of the search term
    const searchWords = locationName.toUpperCase().split(/\s+/);
    const candidates = locationTypeData.fieldVal.filter((loc: any) => {
      const locValue = loc.value.toUpperCase();
      // Check if location contains most of the search words
      return searchWords.filter(word => locValue.includes(word) || word.includes(locValue.split('(')[0].trim())).length >= Math.max(1, searchWords.length - 1);
    });
    
    if (candidates.length > 0) {
      // Prefer exact normalized matches
      match = candidates.find((loc: any) => {
        const normalizedLocValue = loc.value.toUpperCase().replace(/\s+/g, '').split('(')[0];
        return normalizedLocValue === normalizedSearchName || normalizedSearchName.includes(normalizedLocValue);
      }) || candidates[0]; // Fallback to first candidate
    }
  }
  
  // If still no match, try without spaces for both search term and data
  if (!match) {
    match = locationTypeData.fieldVal.find((loc: any) => {
      const normalizedLocValue = loc.value.toUpperCase().replace(/\s+/g, '');
      return normalizedLocValue.includes(normalizedSearchName) || 
             normalizedSearchName.includes(normalizedLocValue.split('(')[0].trim());
    });
  }
  
  return match;
};

/**
 * Get location by code
 * @param code - Location code
 * @param locationType - Type of location
 * @param locationData - The loaded location data
 * @returns The location object if found
 */
const findLocationByCode = (code: string, locationType: string, locationData: any[]): any => {
  const locationTypeData = locationData.find(item => item.name === locationType);
  if (!locationTypeData) return null;
  
  return locationTypeData.fieldVal.find((loc: any) => loc.code === code);
};

/**
 * Process hierarchical location lookup for father's residence using local JSON data
 * @param requestFields - The request fields containing location data
 * @returns Object with all location codes
 */
export const processLocationHierarchy = async (requestFields: any): Promise<{
  districtCode?: string;
  countyCode?: string;
  subCountyCode?: string;
  parishCode?: string;
  villageCode?: string;
}> => {
  const result: any = {};
  
  try {
    // Load location data
    const locationData = loadLocationData();
    
    // Extract values from OpenCRVS format
    const residenceStatus = pickFirstString(requestFields.fatherResidence || requestFields.fatherResidence);
    const villageValue = pickFirstString(requestFields.fatherPlaceOfResidenceVillage);
    
    console.log('[Location Hierarchy] Processing father location with village:', villageValue);
    
    // Only process if residence is UGA (Uganda)
    if (residenceStatus !== 'UGA') {
      console.log('[Location Hierarchy] Residence status is not UGA, skipping hierarchy lookup');
      return result;
    }
    
    if (!villageValue) {
      console.log('[Location Hierarchy] No village value provided');
      return result;
    }
    
    // Find village and traverse hierarchy upward
    const village = findLocationByName(villageValue, 'Village', locationData);
    if (!village) {
      console.log(`[Location Hierarchy] Village "${villageValue}" not found`);
      return result;
    }
    
    result.villageCode = village.code;
    console.log(`[Location Hierarchy] Village "${villageValue}" -> Code: ${result.villageCode}`);
    
    // Get parish using village's parent_loc_code
    const parish = findLocationByCode(village.parent_loc_code, 'Parish', locationData);
    if (parish) {
      result.parishCode = parish.code;
      console.log(`[Location Hierarchy] Parish "${parish.value}" -> Code: ${result.parishCode}`);
      
      // Get subcounty using parish's parent_loc_code
      const subCounty = findLocationByCode(parish.parent_loc_code, 'SubCounty', locationData);
      if (subCounty) {
        result.subCountyCode = subCounty.code;
        console.log(`[Location Hierarchy] SubCounty "${subCounty.value}" -> Code: ${result.subCountyCode}`);
        
        // Get county using subcounty's parent_loc_code
        const county = findLocationByCode(subCounty.parent_loc_code, 'County', locationData);
        if (county) {
          result.countyCode = county.code;
          console.log(`[Location Hierarchy] County "${county.value}" -> Code: ${result.countyCode}`);
          
          // Get district using county's parent_loc_code
          const district = findLocationByCode(county.parent_loc_code, 'District', locationData);
          if (district) {
            result.districtCode = district.code;
            console.log(`[Location Hierarchy] District "${district.value}" -> Code: ${result.districtCode}`);
          }
        }
      }
    }
    
  } catch (error) {
    console.error('[Location Hierarchy] Error processing location hierarchy:', error);
  }
  
  console.log('[Location Hierarchy] Final result:', result);
  return result;
};

/**
 * Process hierarchical location lookup for mother's residence using local JSON data
 * @param requestFields - The request fields containing location data
 * @returns Object with all location codes
 */
export const processMotherLocationHierarchy = async (requestFields: any): Promise<{
  districtCode?: string;
  countyCode?: string;
  subCountyCode?: string;
  parishCode?: string;
  villageCode?: string;
}> => {
  const result: any = {};
  
  try {
    // Load location data
    const locationData = loadLocationData();
    
    // Extract values from OpenCRVS format for mother
    const residenceStatus = pickFirstString(requestFields.motherResidence || requestFields.motherResidence);
    const villageValue = pickFirstString(requestFields.motherPlaceOfResidenceVillage);
    
    console.log('[Location Hierarchy] Processing mother location with village:', villageValue);
    
    // Only process if residence is UGA (Uganda)
    if (residenceStatus !== 'UGA') {
      console.log('[Location Hierarchy] Mother residence status is not UGA, skipping hierarchy lookup');
      return result;
    }
    
    if (!villageValue) {
      console.log('[Location Hierarchy] No mother village value provided');
      return result;
    }
    
    // Find village and traverse hierarchy upward
    const village = findLocationByName(villageValue, 'Village', locationData);
    if (!village) {
      console.log(`[Location Hierarchy] Mother Village "${villageValue}" not found`);
      return result;
    }
    
    result.villageCode = village.code;
    console.log(`[Location Hierarchy] Mother Village "${villageValue}" -> Code: ${result.villageCode}`);
    
    // Get parish using village's parent_loc_code
    const parish = findLocationByCode(village.parent_loc_code, 'Parish', locationData);
    if (parish) {
      result.parishCode = parish.code;
      console.log(`[Location Hierarchy] Mother Parish "${parish.value}" -> Code: ${result.parishCode}`);
      
      // Get subcounty using parish's parent_loc_code
      const subCounty = findLocationByCode(parish.parent_loc_code, 'SubCounty', locationData);
      if (subCounty) {
        result.subCountyCode = subCounty.code;
        console.log(`[Location Hierarchy] Mother SubCounty "${subCounty.value}" -> Code: ${result.subCountyCode}`);
        
        // Get county using subcounty's parent_loc_code
        const county = findLocationByCode(subCounty.parent_loc_code, 'County', locationData);
        if (county) {
          result.countyCode = county.code;
          console.log(`[Location Hierarchy] Mother County "${county.value}" -> Code: ${result.countyCode}`);
          
          // Get district using county's parent_loc_code
          const district = findLocationByCode(county.parent_loc_code, 'District', locationData);
          if (district) {
            result.districtCode = district.code;
            console.log(`[Location Hierarchy] Mother District "${district.value}" -> Code: ${result.districtCode}`);
          }
        }
      }
    }
    
  } catch (error) {
    console.error('[Location Hierarchy] Error processing mother location hierarchy:', error);
  }
  
  console.log('[Location Hierarchy] Mother final result:', result);
  return result;
};
