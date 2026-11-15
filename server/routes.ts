
import type { Express } from "express";
import { createServer, type Server } from "http";

// --------------------------------------------------
// CENTRAL CONFIGURATION
// --------------------------------------------------

// Runtime environment variable pointing to the CENTRAL
// configuration spreadsheet, not the merchant spreadsheet.
const CONFIG_SHEET_ID = process.env.SHEET_ID;
const CONFIG_TAB_NAME = process.env.SHEET_TAB_NAME || "Webapp_Setup";

if (!CONFIG_SHEET_ID) {
  throw new Error(
    "Missing SHEET_ID environment variable. It must contain the central configuration spreadsheet ID."
  );
}

if (!CONFIG_SHEET_ID) {
  throw new Error(
    "Missing SHEET_ID environment variable. It must contain the central configuration spreadsheet ID."
  );
}

interface ColumnMappings {
  businessName: string;
  category: string;
  street: string;
  municipality: string;
  state: string;
  contactPerson: string;
  phone: string;
  email: string;
  previousAdSize: string;
  assignedTo: string;
  volunteerName: string;
  previousSolicitor: string;
}

interface AppConfig {
  sheetId: string;
  apiKey: string;
  merchantsRange: string;
  volunteersRange: string;
  appsScriptUrl: string;
  columns: ColumnMappings;
}

// --------------------------------------------------
// COLUMN LETTER CONVERSION
// --------------------------------------------------

function columnLetterToIndex(column: string): number {
  let index = 0;

  for (const character of column.trim().toUpperCase()) {
    if (character < "A" || character > "Z") {
      throw new Error(`Invalid Google Sheets column letter: ${column}`);
    }

    index = index * 26 + character.charCodeAt(0) - 64;
  }

  return index - 1;
}

// Retrieve a value from a row using its configured
// Google Sheets column letter.
function getCell(row: string[], column: string): string {
  return row[columnLetterToIndex(column)] || "";
}

// --------------------------------------------------
// CSV PARSING
// --------------------------------------------------

// Parse an individual CSV line, including quoted values
// and escaped quotation marks.
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const character = line[i];

    if (character === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (character === "," && !insideQuotes) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  values.push(current);

  return values;
}

// --------------------------------------------------
// CENTRAL CONFIGURATION LOADER
// --------------------------------------------------



async function loadConfig(): Promise<AppConfig> {
  const configUrl =
    `https://docs.google.com/spreadsheets/d/${CONFIG_SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(CONFIG_TAB_NAME)}&headers=0`;

  const response = await fetch(configUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to load central configuration: ${response.status} ${response.statusText}`
    );
  }

  const csv = await response.text();

  // Column A = configuration index
  // Column B = configuration value
  // Column C = description
  const configValues = new Map<number, string>();

  const lines = csv
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;

    const row = parseCsvLine(line);

    const indexText = row[0]?.trim();
    const value = row[1]?.trim() ?? "";

    // Skip headers, blank rows, and non-numeric indices.
    if (!indexText || !/^\d+$/.test(indexText)) continue;

    const index = Number(indexText);

    if (value) {
      configValues.set(index, value);
    }
  }

  // Ensure all 17 configuration entries exist.
  for (let i = 0; i < 17; i++) {
    if (!configValues.has(i)) {
      throw new Error(
        `Missing configuration value at index ${i} (column A index: ${i}).`
      );
    }
  }

  const getValue = (index: number): string =>
    configValues.get(index)!;

  const config: AppConfig = {
    sheetId: getValue(0),
    apiKey: getValue(1),
    merchantsRange: getValue(2),
    volunteersRange: getValue(3),
    appsScriptUrl: getValue(4),

    columns: {
      businessName: getValue(5),
      category: getValue(6),
      street: getValue(7),
      municipality: getValue(8),
      state: getValue(9),
      contactPerson: getValue(10),
      phone: getValue(11),
      email: getValue(12),
      previousAdSize: getValue(13),
      assignedTo: getValue(14),
      volunteerName: getValue(15),
      previousSolicitor: getValue(16),
    },
  };

  console.log("Central configuration loaded successfully:", {
    sheetIdPresent: Boolean(config.sheetId),
    apiKeyPresent: Boolean(config.apiKey),
    configurationEntries: configValues.size,
  });

  return config;
}



// --------------------------------------------------
// GOOGLE SHEETS CACHE
// --------------------------------------------------

const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 30000;

async function fetchFromGoogleSheets(
  config: AppConfig,
  range: string,
  useCache = true
) {
  const cacheKey = `sheets_${config.sheetId}_${range}`;
  const now = Date.now();

  if (useCache && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)!;

    if (now - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
  }

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/` +
    `${config.sheetId}/values/${encodeURIComponent(range)}` +
    `?key=${encodeURIComponent(config.apiKey)}`;

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Google Sheets API error: ${data.error?.message || "Unknown error"}`
    );
  }

  cache.set(cacheKey, {
    data,
    timestamp: Date.now(),
  });

  return data;
}

// --------------------------------------------------
// ADDRESS FORMATTING
// --------------------------------------------------

function simpleFormatAddress(
  streetAndNumber: string,
  municipality: string,
  state: string
): string {
  const parts = [
    streetAndNumber,
    municipality,
    state,
  ].filter((part) => part && part.trim() !== "");

  return parts.length > 0
    ? parts.join(", ")
    : "No address provided";
}

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

export async function registerRoutes(app: Express): Promise<Server> {
  // Load configuration once at startup.
  const config = await loadConfig();

  // ----------------------------------------------
  // MERCHANTS
  // ----------------------------------------------

  app.get("/api/merchants", async (req, res) => {
    try {
      const responseData = await fetchFromGoogleSheets(
        config,
        config.merchantsRange
      );

      if (!responseData.values || responseData.values.length === 0) {
        return res.json([]);
      }

      const merchants = responseData.values
        .slice(1)
        .map((row: string[], index: number) => ({
          id: `merchant_${index}`,

          business_name: getCell(
            row,
            config.columns.businessName
          ),

          category: getCell(
            row,
            config.columns.category
          ),

          sub_category: "",

          address: simpleFormatAddress(
            getCell(row, config.columns.street),
            getCell(row, config.columns.municipality),
            getCell(row, config.columns.state)
          ),

          contact_person: getCell(
            row,
            config.columns.contactPerson
          ),

          phone:
            getCell(row, config.columns.phone) ||
            "No phone number on record",

          email:
            getCell(row, config.columns.email) ||
            "No email on record",

          status: "active",

          previous_ad_size:
            getCell(row, config.columns.previousAdSize) ||
            "Merchant did not purchase",

          assigned_to:
            getCell(row, config.columns.assignedTo) || null,

          previous_solicitor:
            getCell(row, config.columns.previousSolicitor) || null,
        }))
        .filter(
          (merchant: any) =>
            merchant.business_name.trim() !== ""
        );

      res.json(merchants);
    } catch (error) {
      console.error("Error fetching merchants:", error);

      res.status(500).json({
        message: "Failed to fetch merchants from Google Sheets",
      });
    }
  });

  // ----------------------------------------------
  // VOLUNTEERS
  // ----------------------------------------------

  app.get("/api/volunteers", async (req, res) => {
    try {
      const responseData = await fetchFromGoogleSheets(
        config,
        config.volunteersRange
      );

      if (!responseData.values || responseData.values.length === 0) {
        return res.json([]);
      }

      const volunteerNames = Array.from(
        new Set(
          responseData.values
            .slice(1)
            .map((row: string[]) =>
              getCell(row, config.columns.volunteerName)
            )
            .filter(
              (name: string) => name && name.trim() !== ""
            )
        )
      );

      const volunteers = volunteerNames.map(
        (name: string, index: number) => ({
          id: `volunteer_${index}`,
          full_name: name,
          email: `${name.toLowerCase().replace(/\s+/g, ".")}@email.com`,
          phone: `(201) 555-${String(index + 1000).padStart(4, "0")}`,
          role: "volunteer",
          active: true,
        })
      );

      res.json(volunteers);
    } catch (error) {
      console.error("Error fetching volunteers:", error);

      res.status(500).json({
        message: "Failed to fetch volunteers from Google Sheets",
      });
    }
  });

  // ----------------------------------------------
  // ASSIGNMENTS
  // ----------------------------------------------

  app.post("/api/assignments", async (req, res) => {
    try {
      const { merchantName, volunteerName } = req.body;

      if (!merchantName || !volunteerName) {
        return res.status(400).json({
          message: "Merchant name and volunteer name are required",
        });
      }

      const response = await fetch(config.appsScriptUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          merchantName,
          volunteerName,
        }),
      });

      const data = await response.json();

      if (data.status === "success") {
        cache.clear();

        return res.json({
          success: true,
          message: data.message,
        });
      }

      res.status(400).json({
        message: data.message || "Assignment failed",
      });
    } catch (error) {
      console.error("Assignment error:", error);

      res.status(500).json({
        message: "Failed to assign merchant",
      });
    }
  });

  // ----------------------------------------------
  // VOLUNTEER ASSIGNMENTS
  // ----------------------------------------------

  app.get("/api/assignments/:volunteerName", async (req, res) => {
    try {
      const volunteerName = req.params.volunteerName;

      const responseData = await fetchFromGoogleSheets(
        config,
        config.merchantsRange
      );

      if (!responseData.values || responseData.values.length === 0) {
        return res.json([]);
      }

      const assignments = responseData.values
        .slice(1)
        .filter(
          (row: string[]) =>
            getCell(row, config.columns.assignedTo) === volunteerName
        )
        .map((row: string[], index: number) => ({
          id: `merchant_${index}`,

          business_name: getCell(
            row,
            config.columns.businessName
          ),

          category: getCell(
            row,
            config.columns.category
          ),

          sub_category: "",

          address: simpleFormatAddress(
            getCell(row, config.columns.street),
            getCell(row, config.columns.municipality),
            getCell(row, config.columns.state)
          ),

          phone:
            getCell(row, config.columns.phone) ||
            "No phone number on record",

          email:
            getCell(row, config.columns.email) ||
            "No email on record",

          status: "active",

          previous_ad_size:
            getCell(row, config.columns.previousAdSize) ||
            "Merchant did not purchase",

          assigned_to:
            getCell(row, config.columns.assignedTo) || null,
        }));

      res.json(assignments);
    } catch (error) {
      console.error("Error fetching assignments:", error);

      res.status(500).json({
        message: "Failed to fetch assignments",
      });
    }
  });

  // ----------------------------------------------
  // HTTP SERVER
  // ----------------------------------------------

  const httpServer = createServer(app);

  return httpServer;
}
