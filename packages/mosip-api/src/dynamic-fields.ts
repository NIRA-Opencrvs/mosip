import { readFileSync } from "fs";
import * as path from "path";

const DYN_FIELDS_PATH = path.resolve(__dirname, '../../..', 'dynamic_fields_dataset.json');

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
    // Handle both 'value' and 'name' properties (District uses 'name')
    const fieldValue = (fv as any).value || (fv as any).name;
    if (fieldValue) {
      // Store both exact value and lowercase for flexible matching
      valueToCodeMap.set(fieldValue, fv.code);
      valueToCodeMap.set(fieldValue.toLowerCase(), fv.code);
    }
  }
  dynamicFieldsMap.set(field.name, valueToCodeMap);
  dynamicFieldsMap.set(field.name.toLowerCase(), valueToCodeMap);
}

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

// Find district code from dynamic_fields_dataset.json
const findDistrictCode = (districtName: string): string | undefined => {
  const districtData = dynamicFieldsDataset.find(item => item.name === 'District');
  if (!districtData) return undefined;

  const normalizedSearchName = districtName.toUpperCase().trim();

  // Try exact match first
  let match = (districtData.fieldVal as any[]).find((loc: any) =>
    loc.name?.toUpperCase() === normalizedSearchName
  );

  // Try partial match
  if (!match) {
    match = (districtData.fieldVal as any[]).find((loc: any) =>
      loc.name?.toUpperCase().includes(normalizedSearchName) ||
      normalizedSearchName.includes(loc.name?.toUpperCase().split('(')[0].trim())
    );
  }

  return match?.code;
};

// Fetch immediate children locations from MOSIP API
const fetchImmediateChildren = async (
  parentCode: string,
  childType: string,
  authToken: string,
  baseUrl: string
): Promise<Array<{ code: string; name: string; parentLocCode: string }>> => {
  try {
    const url = `${baseUrl}/preregistration/v1/proxy/masterdata/locations/immediatechildren/${parentCode}/${childType}/eng`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `Authorization=${authToken};`
      }
    });

    if (!response.ok) {
      console.error(`[Location API] Failed to fetch ${childType} for parent ${parentCode}: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data?.response?.locations || [];
  } catch (error) {
    console.error(`[Location API] Error fetching ${childType} for parent ${parentCode}:`, error);
    return [];
  }
};

// Find location code from API response by matching name
const findLocationCodeFromApiResponse = (
  locationName: string,
  locations: Array<{ code: string; name: string }>
): string | undefined => {
  if (!locationName || !locations || locations.length === 0) return undefined;

  const normalizedSearchName = locationName.toUpperCase().trim();

  let match = locations.find(loc =>
    loc.name?.toUpperCase() === normalizedSearchName
  );

  if (!match) {
    match = locations.find(loc => {
      const locUpper = loc.name?.toUpperCase() || '';
      return locUpper.includes(normalizedSearchName) ||
        normalizedSearchName.includes(locUpper);
    });
  }

  if (!match) {
    const searchWithoutParens = normalizedSearchName.split('(')[0].trim();
    match = locations.find(loc => {
      const locWithoutParens = (loc.name?.toUpperCase() || '').split('(')[0].trim();
      return locWithoutParens === searchWithoutParens ||
        locWithoutParens.includes(searchWithoutParens) ||
        searchWithoutParens.includes(locWithoutParens);
    });
  }

  if (!match) {
    const firstWord = normalizedSearchName.split(/\s+/)[0];
    if (firstWord && firstWord.length >= 3) {
      match = locations.find(loc => {
        const locUpper = loc.name?.toUpperCase() || '';
        const locFirstWord = locUpper.split(/\s+/)[0];
        return locFirstWord === firstWord || locUpper.startsWith(firstWord);
      });
    }
  }
  if (!match) {
    const abbreviations: Record<string, string[]> = {
      'TOWN COUNCIL': ['TC', 'T/C', 'T.C'],
      'TOWN BOARD': ['TB', 'T/B'],
      'SUB COUNTY': ['SC', 'S/C', 'S.C', 'SUBCOUNTY'],
      'MUNICIPAL COUNCIL': ['MC', 'M/C'],
      'MUNICIPALITY': ['MUNI', 'MUN'],
      'DIVISION': ['DIV'],
    };

    for (const [full, abbrevs] of Object.entries(abbreviations)) {
      if (normalizedSearchName.includes(full)) {
        // Try each abbreviation
        for (const abbrev of abbrevs) {
          const searchWithAbbrev = normalizedSearchName.replace(full, abbrev);
          match = locations.find(loc => {
            const locUpper = loc.name?.toUpperCase() || '';
            return locUpper.includes(searchWithAbbrev) ||
              searchWithAbbrev.includes(locUpper.split('(')[0].trim());
          });
          if (match) break;
        }
      }
      for (const abbrev of abbrevs) {
        if (normalizedSearchName.includes(abbrev)) {
          const searchWithFull = normalizedSearchName.replace(abbrev, full);
          match = locations.find(loc => {
            const locUpper = loc.name?.toUpperCase() || '';
            return locUpper.includes(searchWithFull) ||
              searchWithFull.includes(locUpper.split('(')[0].trim());
          });
          if (match) break;
        }
      }
      if (match) break;
    }
  }

  return match?.code;
};

export const processLocationHierarchy = async (
  requestFields: any,
  authToken: string,
  baseUrl: string
): Promise<{
  districtCode?: string;
  countyCode?: string;
  subCountyCode?: string;
  parishCode?: string;
  villageCode?: string;
}> => {
  const result: any = {};

  try {
    const residenceStatus = pickFirstString(requestFields.appBirCountryUGA);

    // Only process for Uganda residents
    if (residenceStatus !== 'UGA') {
      console.log('[Location Hierarchy] Skipping - not Uganda resident');
      return result;
    }

    // Extract location values from request fields
    const districtValue = pickFirstString(requestFields.applicantPlaceOfBirthDistrict);
    const countyValue = pickFirstString(requestFields.applicantPlaceOfBirthCounty);
    const subCountyValue = pickFirstString(requestFields.applicantPlaceOfBirthSubCounty);
    const parishValue = pickFirstString(requestFields.applicantPlaceOfBirthParish);
    const villageValue = pickFirstString(requestFields.applicantPlaceOfBirthVillage);

    if (!districtValue) {
      console.log('[Location Hierarchy] No district value provided');
      return result;
    }

    const districtCode = findDistrictCode(districtValue);
    if (!districtCode) {
      return result;
    }
    result.districtCode = districtCode;

    if (countyValue) {
      const counties = await fetchImmediateChildren(districtCode, 'County', authToken, baseUrl);
      const countyCode = findLocationCodeFromApiResponse(countyValue, counties);
      if (countyCode) {
        result.countyCode = countyCode;


        if (subCountyValue) {
          const subCounties = await fetchImmediateChildren(countyCode, 'SubCounty', authToken, baseUrl);
          const subCountyCode = findLocationCodeFromApiResponse(subCountyValue, subCounties);
          if (subCountyCode) {
            result.subCountyCode = subCountyCode;


            if (parishValue) {
              const parishes = await fetchImmediateChildren(subCountyCode, 'Parish', authToken, baseUrl);
              const parishCode = findLocationCodeFromApiResponse(parishValue, parishes);
              if (parishCode) {
                result.parishCode = parishCode;


                if (villageValue) {
                  const villages = await fetchImmediateChildren(parishCode, 'Village', authToken, baseUrl);
                  const villageCode = findLocationCodeFromApiResponse(villageValue, villages);
                  if (villageCode) {
                    result.villageCode = villageCode;
                  } else {
                    console.log(`[Location Hierarchy] Village not found: ${villageValue}`);
                  }
                }
              } else {
                console.log(`[Location Hierarchy] Parish not found: ${parishValue}`);
              }
            }
          } else {
            console.log(`[Location Hierarchy] SubCounty not found: ${subCountyValue}`);
          }
        }
      } else {
        console.log(`[Location Hierarchy] County not found: ${countyValue}`);
      }
    }

  } catch (error) {
    console.error('[Location Hierarchy] Error processing location hierarchy:', error);
  }
  return result;
};