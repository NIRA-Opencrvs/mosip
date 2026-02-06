import { readFileSync } from "fs";
import * as path from "path";

type DynamicFieldsDataset = Array<{ name: string; fieldVal: Array<{ code: string; value: string }> }>;

const loadDynamicFields = (): Map<string, Map<string, string>> => {
  const map = new Map<string, Map<string, string>>();
  try {
    const dataset: DynamicFieldsDataset = JSON.parse(
      readFileSync(path.resolve(__dirname, 'dynamic_fields_dataset.json'), 'utf8')
    );
    console.log(`[Dynamic Fields] Loaded ${dataset.length} field types from dataset`);
    for (const field of dataset) {
      const valueToCodeMap = new Map<string, string>();
      for (const fv of field.fieldVal) {
        valueToCodeMap.set(fv.value, fv.code);
        valueToCodeMap.set(fv.value.toLowerCase(), fv.code);
      }
      map.set(field.name, valueToCodeMap);
      map.set(field.name.toLowerCase(), valueToCodeMap);
    }
    console.log(`[Dynamic Fields] Successfully initialized ${map.size / 2} fields`);
  } catch (e) {
    console.warn('[Dynamic Fields] Failed to load:', (e as Error).message);
  }
  return map;
};

const dynamicFieldsMap = loadDynamicFields();
interface LocationAPIResponse {
  id: string;
  version: string;
  responsetime: string;
  metadata: any;
  response: {
    locations: Array<{
      code: string;
      name: string;
      hierarchyLevel: number;
      hierarchyLevelName: string;
      parentLocCode: string;
      langCode: string;
      isActive: boolean;
    }>;
  };
  errors: any[] | null;
}

interface LocationHierarchyResult {
  districtCode?: string;
  countyCode?: string;
  subCountyCode?: string;
  parishCode?: string;
  villageCode?: string;
}

const normalizeLocationName = (name: string): string => {
  return name.toUpperCase().replace(/\s*\([^)]*\)\s*/g, '').replace(/\s+/g, ' ').trim();
};

const getChildren = async (
  parentCode: string,
  level: string,
  authToken: string,
  baseUrl: string
): Promise<LocationAPIResponse['response']['locations']> => {
  try {
    const url = `${baseUrl}/preregistration/v1/proxy/masterdata/locations/immediatechildren/${parentCode}/${level}/eng`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Cookie: `Authorization=${authToken};` }
    });

    if (!response.ok) return [];
    const data: LocationAPIResponse = await response.json();
    if (data.errors?.length) return [];
    return (data.response?.locations || []).filter(loc => loc.isActive);
  } catch (error) {
    console.error(`Location API error (${level}/${parentCode}):`, error);
    return [];
  }
};

const logNotFound = (
  levelName: string, 
  searchedValue: string, 
  available: LocationAPIResponse['response']['locations'],
  parentName?: string
): void => {
  console.warn(`[Location] ${levelName} not found: "${searchedValue}"`);
  if (parentName) {
    console.warn(`[Location] Searched under: ${parentName}`);
  }
  console.warn(`[Location] Available ${levelName}s:`, available.map(l => l.name).join(', ') || 'None');
};

const findLocationByName = (
  locations: LocationAPIResponse['response']['locations'],
  searchName: string
): LocationAPIResponse['response']['locations'][0] | undefined => {
  if (!searchName) return undefined;
  const normalized = normalizeLocationName(searchName);
  return locations.find(loc => normalizeLocationName(loc.name) === normalized);
};

const resolveLocationHierarchy = async (
  villageSearchName: string | undefined,
  districtSearchName: string | undefined,
  countySearchName: string | undefined,
  subCountySearchName: string | undefined,
  parishSearchName: string | undefined,
  authToken: string,
  baseUrl: string
): Promise<LocationHierarchyResult> => {
  const result: LocationHierarchyResult = {};
  if (!villageSearchName) return result;

  try {
    const districts = await getChildren('UGA', 'District', authToken, baseUrl);
    if (!districts.length) return result;

    if (!districtSearchName) {
      console.warn('[Location] District name is required for hierarchy resolution');
      return result;
    }

    const district = findLocationByName(districts, districtSearchName);
    if (!district) {
      logNotFound('District', districtSearchName, districts, 'Uganda');
      return result;
    }
    result.districtCode = district.code;

    const counties = await getChildren(district.code, 'County', authToken, baseUrl);
    if (!counties.length) return result;

    if (!countySearchName) {
      console.warn('[Location] County name is required for hierarchy resolution');
      return result;
    }

    const county = findLocationByName(counties, countySearchName);
    if (!county) {
      logNotFound('County', countySearchName, counties, `District: ${district.name}`);
      return result;
    }
    result.countyCode = county.code;

    const subCounties = await getChildren(county.code, 'SubCounty', authToken, baseUrl);
    if (!subCounties.length) return result;

    if (!subCountySearchName) {
      console.warn('[Location] SubCounty name is required for hierarchy resolution');
      return result;
    }

    const subCounty = findLocationByName(subCounties, subCountySearchName);
    if (!subCounty) {
      logNotFound('SubCounty', subCountySearchName, subCounties, `County: ${county.name}`);
      return result;
    }
    result.subCountyCode = subCounty.code;

    const parishes = await getChildren(subCounty.code, 'Parish', authToken, baseUrl);
    if (!parishes.length) return result;

    if (!parishSearchName) {
      console.warn('[Location] Parish name is required for hierarchy resolution');
      return result;
    }

    const parish = findLocationByName(parishes, parishSearchName);
    if (!parish) {
      logNotFound('Parish', parishSearchName, parishes, `SubCounty: ${subCounty.name}`);
      return result;
    }
    result.parishCode = parish.code;

    const villages = await getChildren(parish.code, 'Village', authToken, baseUrl);
    const village = findLocationByName(villages, villageSearchName);
    
    if (village) {
      result.villageCode = village.code;
      return result;
    } else {
      logNotFound('Village', villageSearchName, villages, `Parish: ${parish.name}`);
      return result;
    }
  } catch (error) {
    console.error('Location hierarchy error:', error);
    return result;
  }
};

export const isDynamicField = (fieldName: string): boolean => {
  return dynamicFieldsMap.has(fieldName) || dynamicFieldsMap.has(fieldName.toLowerCase());
};

export const findCodeForFieldValue = (fieldName: string, label?: string | null): string | undefined => {
  if (!label) return undefined;
  const needle = String(label).trim();
  const valueToCodeMap = dynamicFieldsMap.get(fieldName) || dynamicFieldsMap.get(fieldName.toLowerCase());
  return valueToCodeMap?.get(needle) || valueToCodeMap?.get(needle.toLowerCase()) || needle;
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

const processLocationHierarchy = async (
  requestFields: any,
  authToken: string,
  baseUrl: string,
  countryField: string,
  villageField: string,
  districtField: string,
  countyField: string,
  subCountyField: string,
  parishField: string
): Promise<LocationHierarchyResult> => {
  const residenceStatus = pickFirstString(requestFields[countryField]);
  if (residenceStatus !== 'UGA') return {};

  const villageValue = pickFirstString(requestFields[villageField]);
  if (!villageValue) return {};

  return resolveLocationHierarchy(
    villageValue,
    pickFirstString(requestFields[districtField]),
    pickFirstString(requestFields[countyField]),
    pickFirstString(requestFields[subCountyField]),
    pickFirstString(requestFields[parishField]),
    authToken,
    baseUrl
  );
};

export const processApplicantLocationHierarchy = async (
  requestFields: any,
  authToken: string,
  baseUrl: string
): Promise<LocationHierarchyResult> => {
  return processLocationHierarchy(
    requestFields,
    authToken,
    baseUrl,
    'appBirCountryUGA',
    'applicantPlaceOfBirthVillage',
    'applicantPlaceOfBirthDistrict',
    'applicantPlaceOfBirthCounty',
    'applicantPlaceOfBirthSubCounty',
    'applicantPlaceOfBirthParish'
  );
};

export const processFatherLocationHierarchy = async (
  requestFields: any,
  authToken: string,
  baseUrl: string
): Promise<LocationHierarchyResult> => {
  return processLocationHierarchy(
    requestFields,
    authToken,
    baseUrl,
    'fatResCountryUGA',
    'fatherPlaceOfResidenceVillage',
    'fatherPlaceOfResidenceDistrict',
    'fatherPlaceOfResidenceCounty',
    'fatherPlaceOfResidenceSubCounty',
    'fatherPlaceOfResidenceParish'
  );
};

export const processMotherLocationHierarchy = async (
  requestFields: any,
  authToken: string,
  baseUrl: string
): Promise<LocationHierarchyResult> => {
  return processLocationHierarchy(
    requestFields,
    authToken,
    baseUrl,
    'motResCountryUGA',
    'motherPlaceOfResidenceVillage',
    'motherPlaceOfResidenceDistrict',
    'motherPlaceOfResidenceCounty',
    'motherPlaceOfResidenceSubCounty',
    'motherPlaceOfResidenceParish'
  );
};