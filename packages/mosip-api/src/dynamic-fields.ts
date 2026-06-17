import { readFileSync } from "fs";
import * as path from "path";

const DYN_FIELDS_PATH = path.resolve(__dirname, 'dynamic_fields_dataset.json');

type DynamicFieldsDataset = Array<{ name: string; fieldVal: Array<{ code: string; value: string }> }>;

let dynamicFieldsDataset: DynamicFieldsDataset = [];
try {
  dynamicFieldsDataset = JSON.parse(readFileSync(DYN_FIELDS_PATH, 'utf8'));
  console.log(`[Dynamic Fields] Loaded ${dynamicFieldsDataset.length} fields from ${DYN_FIELDS_PATH}`);
} catch (e) {
  console.warn(`[Dynamic Fields] Could not load dataset from ${DYN_FIELDS_PATH}:`, (e as Error).message);
}

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

const LOCATION_DATA_PATH = path.resolve(__dirname, 'location_data.json');

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


export const loadLocationData = (): LocationDataset => {
  return locationDataset;
};

export const isDynamicField = (fieldName: string): boolean => {
  return dynamicFieldsMap.has(fieldName) || dynamicFieldsMap.has(fieldName.toLowerCase());
};

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

  return needle;
};

export const findCodeForFieldValueStrict = (fieldName: string, label?: string | null): string | undefined => {
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

  return undefined;
};


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


export const isLangArrayString = (value: any): boolean => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('[{"language"') || trimmed.startsWith('[{\"language\"');
};


const findLocationByName = (locationName: string, locationType: string, locationData: any[]): any => {
  const locationTypeData = locationData.find(item => item.name === locationType);
  if (!locationTypeData) return null;
  const normalizedSearchName = locationName.toUpperCase().replace(/\s+/g, '');
  
  let match = locationTypeData.fieldVal.find((loc: any) => 
    loc.value.toUpperCase().includes(locationName.toUpperCase())
  );
  
  if (!match && locationType === 'Village') {
    const searchWords = locationName.toUpperCase().split(/\s+/);
    const candidates = locationTypeData.fieldVal.filter((loc: any) => {
      const locValue = loc.value.toUpperCase();
      return searchWords.filter(word => locValue.includes(word) || word.includes(locValue.split('(')[0].trim())).length >= Math.max(1, searchWords.length - 1);
    });
    
    if (candidates.length > 0) {
      match = candidates.find((loc: any) => {
        const normalizedLocValue = loc.value.toUpperCase().replace(/\s+/g, '').split('(')[0];
        return normalizedLocValue === normalizedSearchName || normalizedSearchName.includes(normalizedLocValue);
      }) || candidates[0]; 
    }
  }
  
  if (!match) {
    match = locationTypeData.fieldVal.find((loc: any) => {
      const normalizedLocValue = loc.value.toUpperCase().replace(/\s+/g, '');
      return normalizedLocValue.includes(normalizedSearchName) || 
             normalizedSearchName.includes(normalizedLocValue.split('(')[0].trim());
    });
  }
  
  return match;
};


const findLocationByCode = (code: string, locationType: string, locationData: any[]): any => {
  const locationTypeData = locationData.find(item => item.name === locationType);
  if (!locationTypeData) return null;
  
  return locationTypeData.fieldVal.find((loc: any) => loc.code === code);
};


export const processApplicantLocationHierarchy = async (requestFields: any): Promise<{
  districtCode?: string;
  countyCode?: string;
  subCountyCode?: string;
  parishCode?: string;
  villageCode?: string;
}> => {
  const result: any = {};
  
  try {
    const locationData = loadLocationData();
    const residenceStatus = pickFirstString(requestFields.appBirCountryUGA);
    const villageValue = pickFirstString(requestFields.applicantPlaceOfBirthVillage);
    if (residenceStatus !== 'UGA') {
      return result;
    }
    
    if (!villageValue) {
      return result;
    }
    const village = findLocationByName(villageValue, 'Village', locationData);

    if (!village) {
      return result;
    }
    
    result.villageCode = village.code;
    const parish = findLocationByCode(village.parent_loc_code, 'Parish', locationData);
    if (parish) {
      result.parishCode = parish.code;
      const subCounty = findLocationByCode(parish.parent_loc_code, 'SubCounty', locationData);
      if (subCounty) {
        result.subCountyCode = subCounty.code;
        const county = findLocationByCode(subCounty.parent_loc_code, 'County', locationData);
        if (county) {
          result.countyCode = county.code;
          const district = findLocationByCode(county.parent_loc_code, 'District', locationData);
          if (district) {
            result.districtCode = district.code;
          }
        }
      }
    }
    
  } catch (error) {
    console.error('[Location Hierarchy] Error processing location hierarchy:', error);
  }
  return result;
};

export const processFatherLocationHierarchy = async (requestFields: any): Promise<{
  districtCode?: string;
  countyCode?: string;
  subCountyCode?: string;
  parishCode?: string;
  villageCode?: string;
}> => {
  const result: any = {};
  
  try {
    const locationData = loadLocationData();
    const residenceStatus = pickFirstString(requestFields.fatResCountryUGA);
    const villageValue = pickFirstString(requestFields.fatherPlaceOfResidenceVillage);
    if (residenceStatus !== 'UGA') {
      return result;
    }
    
    if (!villageValue) {
      return result;
    }
    const village = findLocationByName(villageValue, 'Village', locationData);

    if (!village) {
      return result;
    }
    
    result.villageCode = village.code;
    const parish = findLocationByCode(village.parent_loc_code, 'Parish', locationData);
    if (parish) {
      result.parishCode = parish.code;
      const subCounty = findLocationByCode(parish.parent_loc_code, 'SubCounty', locationData);
      if (subCounty) {
        result.subCountyCode = subCounty.code;
        const county = findLocationByCode(subCounty.parent_loc_code, 'County', locationData);
        if (county) {
          result.countyCode = county.code;
          const district = findLocationByCode(county.parent_loc_code, 'District', locationData);
          if (district) {
            result.districtCode = district.code;
          }
        }
      }
    }
    
  } catch (error) {
    console.error('[Location Hierarchy] Error processing location hierarchy:', error);
  }
  return result;
};

export const processMotherLocationHierarchy = async (requestFields: any): Promise<{
  districtCode?: string;
  countyCode?: string;
  subCountyCode?: string;
  parishCode?: string;
  villageCode?: string;
}> => {
  const result: any = {};
  
  try {
    const locationData = loadLocationData();
    const residenceStatus = pickFirstString(requestFields.motResCountryUGA);
    const villageValue = pickFirstString(requestFields.motherPlaceOfResidenceVillage);
    if (residenceStatus !== 'UGA') {
      return result;
    }
    
    if (!villageValue) {
      return result;
    }
    const village = findLocationByName(villageValue, 'Village', locationData);

    if (!village) {
      return result;
    }
    
    result.villageCode = village.code;
    const parish = findLocationByCode(village.parent_loc_code, 'Parish', locationData);
    if (parish) {
      result.parishCode = parish.code;
      const subCounty = findLocationByCode(parish.parent_loc_code, 'SubCounty', locationData);
      if (subCounty) {
        result.subCountyCode = subCounty.code;
        const county = findLocationByCode(subCounty.parent_loc_code, 'County', locationData);
        if (county) {
          result.countyCode = county.code;
          const district = findLocationByCode(county.parent_loc_code, 'District', locationData);
          if (district) {
            result.districtCode = district.code;
          }
        }
      }
    }
    
  } catch (error) {
    console.error('[Location Hierarchy] Error processing location hierarchy:', error);
  }
  return result;
};