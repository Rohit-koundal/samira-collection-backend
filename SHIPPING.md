# Blue Dart delivery setup

Existing manual shipping remains the default. This integration does not activate a
Blue Dart business account, negotiate rates, or enable COD/reverse services on the
carrier account. Obtain those permissions from Blue Dart first.

## Backend connection

Keep all credentials in `backend/.env` or your backend host's secret environment.
Never use `REACT_APP_` variables for courier credentials. Existing environment
values must be preserved when adding this configuration.

| Variable | Purpose |
| --- | --- |
| BLUEDART_MODE | `sandbox` for account testing; `production` for real delivery |
| BLUEDART_CLIENT_ID / BLUEDART_CLIENT_SECRET | Approved gateway application credentials |
| BLUEDART_LOGIN_ID / BLUEDART_LICENCE_KEY | Shipping API profile issued by Blue Dart |
| BLUEDART_JWT_TOKEN | Optional backend token override; omit for automatic token acquisition |
| BLUEDART_CUSTOMER_CODE | Six-character Blue Dart customer account code |
| BLUEDART_ORIGIN_AREA | Three-character registered origin area |
| BLUEDART_PRODUCT_CODE / BLUEDART_PACK_TYPE / BLUEDART_FEATURE | Values agreed for the account and contracted service; do not copy example product codes |
| BLUEDART_PICKUP_SUBPRODUCT | Carrier pickup subproduct name, default `E-Tailing`; confirm with the account manager |
| BLUEDART_TRACKING_LICENCE_KEY | Optional separate tracking licence; otherwise the shipping licence is used |
| BLUEDART_LIVE_BOOKING_ENABLED | Keep `false` until production booking is approved; must be `true` for live checkout |
| BLUEDART_COD_ENABLED | Set `true` only after COD is enabled by Blue Dart; store COD rules and PIN serviceability also apply |
| BLUEDART_REVERSE_ENABLED / BLUEDART_REVERSE_FEATURE | Enable only after reverse pickup and its service feature are confirmed |

Authentication uses the gateway token login with ClientID/clientSecret headers.
The public shipping specifications require JWTToken, but the authentication guide
currently requires a DHL developer login. Verify token acquisition and the issued
profile in your approved account before production activation. A backend JWT token
override is available for sandbox validation. Tokens and provider response bodies
are never sent to the storefront.

The direct XML parser dependency is pinned in backend package.json/package-lock.json.
Install backend dependencies when deploying and restart the backend after changing
environment configuration. The frontend and backend must be deployed together.

## Store settings and operation

In **Settings → Orders & delivery**, set the registered pickup contact/address,
package defaults and delivery pricing. Choose Manual or Blue Dart. Fixed pricing
uses the existing delivery charge. The rate card uses the longest matching PIN
prefix, the first weight slab and an amount per additional slab. Unmatched PINs
use default rates. Free delivery can be enabled/disabled separately.

These are merchant-managed customer charges, not a live Blue Dart tariff quote.
Confirm contracted rates, taxes/surcharges, the volumetric divisor, service limits
and packaging restrictions with the account manager. Checkout charges use the
greater of estimated actual/volumetric weight. Confirm actual packed measurements
in the order screen; those cannot change an already agreed customer total.

Set product packed unit weights in Add/Edit Product, or use the store default.
The initial implementation books one outer parcel per order and supports domestic
India shipments. Split shipments, multi-box consignments and international customs
documents require additional provider work. Blue Dart address lines are limited
to 30 characters each (90 total); contact names are limited to 30 characters.

An order stays in the local database. From its **Courier delivery** panel:

1. Confirm payment for prepaid orders, or customer confirmation if COD requires it.
2. Enter packed weight/dimensions and the planned pickup slot in India time.
3. Create the shipment. The actual carrier AWB and PDF label are saved immediately.
4. Download and print the PDF label; attach it to the parcel.
5. Request pickup. Pickup registration is separate from AWB creation. A rejected
   pickup can be retried using the same AWB.

The label endpoint is authenticated and returns the original carrier PDF. If the
carrier does not return a PDF, retrieve the original label from the carrier portal
using the AWB. Never generate a second AWB simply to recover a label.

Delivery events are polled automatically, approximately every 15 minutes, while
the backend is running and MongoDB is connected. Customer/admin refresh requests
are throttled to once per shipment per minute. The UI shows the last check time
and retains the last confirmed status during an outage. No unauthenticated or
assumed Blue Dart webhook is installed; an account-specific webhook can be added
when its authentication contract is available.

COD delivery never marks the payment Paid. Record collection/remittance through
the existing payment workflow after confirmation. A returned-to-origin scan does
not restore inventory or refund money. Inspect the physical return and use the
existing returns/refunds workflow.

Approve a return first, then select **Manage reverse pickup** in Returns. Reverse
shipments have their own collection/reference and do not replace the forward AWB.
Only the approved order line/quantity is included. Reverse serviceability is
checked from customer to store. Reverse delivery does not automatically approve
quality, restore stock, exchange goods or refund payment.

## Uncertain outcomes and cancellation

Booking and pickup requests are not automatically retried after a timeout or
unreadable response. Use **Check booking outcome** to recover an existing AWB by
reference. For an uncertain pickup, record the pickup token confirmed by Blue Dart.
Unlock a retry only after Blue Dart explicitly confirms that no request exists.
A missing tracking result by itself is not evidence that booking failed.

Courier cancellation cancels a registered pickup before cancelling its AWB.
Order cancellation proceeds with the existing stock/refund logic only after the
carrier confirms the cancellation. A picked-up parcel must follow a return flow.
Cancelling just the courier booking does not cancel/refund the customer order.
Cancelled AWBs are retained as history; replacement bookings are not automatically
created from cancelled records.

## Activation checks with Blue Dart

Use the approved sandbox and account-provided test orders to verify authentication,
prepaid/COD PIN checks, booking, readable label/barcode, pickup token/date,
cancellation, tracking and approved reverse pickup. Confirm a physical production
pickup with your account manager before advertising live delivery. Sandbox
shipments do not move real parcels and do not update an order as delivered.
Live checkout intentionally refuses a sandbox or incomplete courier connection.

No real shipment, pickup, customer notification or courier charge should be created
by automated local tests. This integration's local verification uses in-memory
provider/model fixtures, without creating stored test-data/report files.

## Provider boundary

`shippingProvider.providerFor()` selects an adapter implementing `readiness`,
`serviceability`, `book`, `pickup`, `cancelPickup`, `cancel`, and `track`.
`deliveryService` owns persistence, action locks, reconciliation, status mapping
and polling. `shippingRules` owns parcel/pricing validation. Add another adapter
and provider option without rewriting cart, payments or order storage.

Forward Shipment keeps its existing unique order index. ReverseShipment uses a
separate collection with a unique returnRequest index. Ensure these indexes exist
when production MongoDB automatic index creation is disabled.

Official contracts:
- https://developer.dhl.com/api-reference/waybill-dhl-ecommerce-india-blue-dart
- https://developer.dhl.com/api-reference/location-finder-dhl-ecommerce-india-blue-dart
- https://developer.dhl.com/api-reference/registration-pickup-dhl-ecommerce-india-blue-dart
- https://developer.dhl.com/api-reference/pickup-cancellation-dhl-ecommerce-india-blue-dart
- https://developer.dhl.com/api-reference/shipment-tracking-dhl-ecommerce-india-blue-dart
