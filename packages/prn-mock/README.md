# prn-mock

A complete **PRN (Provisional Registration Number) Payment Validator** mock server for local development. This service simulates payment verification in the OpenCRVS MOSIP registration system.

## Overview

This mock server provides a validation endpoint where users can check their PRN registration status and payment information. It simulates the complete flow from validation page display to returning payment status back to the client form.

**Key Features:**
- Interactive validation page with a clean UI
- Mock PRN database with payment status (paid/unpaid)
- Secure redirect URI tracking for data exchange
- Multiple endpoint support (form-based and query-based)
- Full end-to-end flow integration with OpenCRVS forms

## Usage

### Local Development

```bash
# Install dependencies
yarn install

# Run in development mode (with hot-reloading)
yarn dev

# Run in production mode
yarn start
```

The server will start on `http://localhost:20261` by default.

## API Endpoints

### 1. GET `/validate?redirect_uri=<uri>`
Displays the PRN validation page.

**Query Parameters:**
- `redirect_uri` (required): The URI to redirect back to after validation

**Example:**
```
GET http://localhost:20261/validate?redirect_uri=http://localhost:3000/form?step=payment-verify
```

**Response:** HTML page with validation form

---

### 2. POST `/validate/check`
Validates a PRN and returns payment status.

**Body (Form Data):**
```
prn=PRN001001
redirect_uri=http://localhost:3000/form
```

**Response (Success - 200):**
```json
{
  "success": true,
  "prn": "PRN001001",
  "applicantName": "John Doe",
  "registrationType": "birth",
  "submissionDate": "2024-01-15",
  "paymentStatus": "paid",
  "amount": 500,
  "message": "Payment verified! Registration can proceed."
}
```

**Response (Error - 404):**
```json
{
  "success": false,
  "prn": "INVALID123",
  "message": "PRN \"INVALID123\" not found in the system."
}
```

---

### 3. GET `/validate-status?prn=<prn>`
Alternative endpoint for checking PRN status (GET method).

**Query Parameters:**
- `prn` (required): The PRN number to validate

**Example:**
```
GET http://localhost:20261/validate-status?prn=PRN001001
```

**Response:**
```json
{
  "success": true,
  "prn": "PRN001001",
  "applicantName": "John Doe",
  "registrationType": "birth",
  "submissionDate": "2024-01-15",
  "paymentStatus": "paid",
  "amount": 500,
  "message": "Payment verified! Registration can proceed."
}
```

---

### 4. GET `/health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

## Complete End-to-End Flow

### Step 1: Form Displays "Verify Payment" Button
In your OpenCRVS form, add a button that redirects to the PRN validator:

```html
<button onclick="openPRNValidator()">Verify Payment</button>

<script>
  function openPRNValidator() {
    const redirectUri = encodeURIComponent(window.location.href);
    const validatorUrl = `http://localhost:20261/validate?redirect_uri=${redirectUri}`;
    window.location.href = validatorUrl;
  }
</script>
```

### Step 2: User Enters PRN on Validation Page
- User is redirected to `http://localhost:20261/validate?redirect_uri=...`
- Sees the validation page with PRN input field
- Enters a PRN (e.g., `PRN001001`)
- Clicks "Validate PRN" button

### Step 3: Validation Processing
- The page sends the PRN to `/validate/check` endpoint
- Server looks up the PRN in `mock-prn-data.json`
- Returns payment status and user details

### Step 4: Auto-Redirect with Data
- If validation succeeds, the page displays results for 2 seconds
- Automatically redirects back to the original form with validation data in query params:
  ```
  http://localhost:3000/form?step=payment-verify&prn_validation={"success":true,"paymentStatus":"paid",...}
  ```

### Step 5: Form Processes Validation Response
- The form receives the `prn_validation` query parameter
- Parses the JSON response
- If `paymentStatus === "paid"`, enables submission
- If `paymentStatus === "unpaid"`, shows payment pending message

## Mock Data Structure

The file `src/mock-prn-data.json` contains mock PRN records:

```json
{
  "prn": "PRN001001",
  "applicantName": "John Doe",
  "registrationType": "birth",
  "submissionDate": "2024-01-15",
  "paymentStatus": "paid",
  "amount": 500
}
```

**Fields:**
- `prn`: Unique PRN identifier
- `applicantName`: Name of the applicant
- `registrationType`: Type of registration (birth/death)
- `submissionDate`: When the form was submitted
- `paymentStatus`: Payment status (paid/unpaid)
- `amount`: Amount due in currency units

## Integration Example

### In Your OpenCRVS Form (React/JavaScript):

```javascript
// Check if we have PRN validation data in URL
const params = new URLSearchParams(window.location.search);
const prnValidation = params.get("prn_validation");

if (prnValidation) {
  const validationData = JSON.parse(prnValidation);
  
  if (validationData.success && validationData.paymentStatus === "paid") {
    // Enable form submission
    setPaymentVerified(true);
    showNotification(`Payment verified for ${validationData.applicantName}`);
  } else if (validationData.success && validationData.paymentStatus === "unpaid") {
    // Show payment pending message
    showWarning(`Payment pending. Amount due: ₹${validationData.amount}`);
  }
}

function openPRNValidator() {
  const redirectUri = encodeURIComponent(window.location.href);
  window.open(
    `http://localhost:20261/validate?redirect_uri=${redirectUri}`,
    "prnValidator",
    "width=600,height=800"
  );
}
```

## Docker Deployment

Build and run the PRN validator in Docker:

```bash
# Build the image
docker build -t opencrvs/prn-mock:latest .

# Run the container
docker run -p 20261:20261 \
  -e HOST=0.0.0.0 \
  -e PORT=20261 \
  opencrvs/prn-mock:latest
```

## Configuration

Environment variables can be set via `.env` file or system environment:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 20261 | Server port |
| `HOST` | 0.0.0.0 | Server host (0.0.0.0 for all interfaces) |

## File Structure

```
prn-mock/
├── src/
│   ├── index.ts                    # Main server logic
│   ├── constants.ts                # Environment configuration
│   ├── mock-prn-data.json          # PRN database
│   └── prn-validator/
│       └── index.html              # Validation UI page
├── Dockerfile                       # Docker configuration
├── package.json                     # Dependencies and scripts
├── tsconfig.json                    # TypeScript configuration
└── README.md                        # This file
```

## Mock PRN Data

Available test PRNs for validation:

| PRN | Name | Status | Amount |
|-----|------|--------|--------|
| PRN001001 | John Doe | PAID | ₹500 |
| PRN001002 | Jane Smith | UNPAID | ₹750 |
| PRN001003 | Charles Dickens | PAID | ₹500 |
| PRN001004 | Monica Geller | UNPAID | ₹500 |
| PRN001005 | Ross Geller | PAID | ₹750 |
| PRN001006 | Rachel Green | PAID | ₹500 |
| PRN001007 | Chandler Bing | UNPAID | ₹500 |
| PRN001008 | Phoebe Buffay | PAID | ₹750 |
| PRN001009 | Joey Tribbiani | UNPAID | ₹500 |
| PRN001010 | James Bond | PAID | ₹500 |

## Security Notes

- This is a **mock server** for local development only
- Redirect URIs are tracked for single-use validation (one-time use)
- No authentication is required for local testing
- For production, implement proper JWT signing and OAuth2 flows

## Troubleshooting

### Port Already in Use
```bash
# Change the PORT environment variable
PORT=20262 yarn start
```

### PRN Not Found
Ensure the PRN format matches entries in `mock-prn-data.json`. PRN comparison is case-insensitive.

### Redirect Not Working
Verify that:
1. `redirect_uri` is properly URL-encoded
2. The URI doesn't contain query parameters (they're stripped for validation)
3. Browser allows popup redirects

## Development

To add more mock PRNs, edit `src/mock-prn-data.json`:

```json
{
  "prn": "PRN001020",
  "applicantName": "Your Name",
  "registrationType": "birth",
  "submissionDate": "2024-02-18",
  "paymentStatus": "paid",
  "amount": 500
}
```

## License

MPL-2.0

## Support

For issues or feature requests, refer to the main OpenCRVS MOSIP repository.
