## Calendars and contacts for your mailboxes

Radicale adds CalDAV calendars and CardDAV address books alongside OpenShip Mail. It is an optional app: install it on the mail server or another server, then manage its deployments, settings, and storage under Apps.

It uses Radicale's built-in IMAP authentication. Users sign in with their **full mailbox email address and mailbox password**, including mailboxes on additional domains hosted by that IMAP server. There is no second account database or administrator password to synchronize. Each mailbox can access only its own collections.

## Install

1. Set up Mail and create your mailboxes first. Copy the hostname from **Mail → Overview**, for example `mail.example.com`.
2. Install Radicale and enter that hostname as **IMAP hostname**. The app must be able to reach it on port **993**, and the mail server must present a valid, trusted TLS certificate for that hostname. Authentication fails if the certificate is invalid or the server is unreachable.
3. Give Radicale its own HTTPS hostname, such as `dav.example.com`, using the standard app domain settings. Wait for the domain and certificate to be ready before connecting clients. Keep the existing mail, MX, and webmail DNS records unchanged.
4. Open the HTTPS address and sign in with a mailbox account. Use Radicale's collection manager to create a calendar and an address book, or import existing `.ics` and `.vcf` files.

The app can also use an existing external IMAPS server. That server must allow password authentication; OAuth-only mail providers are not supported by this template. When hosting the app in Cloud, the IMAPS hostname must be reachable from Cloud.

## Connect native clients

Add a **CalDAV account** for calendars and a **CardDAV account** for contacts. Enter the Radicale server hostname, enable SSL/TLS, use port **443**, and supply your full mailbox email address and password. In DAVx⁵, use “Login with URL and user name” and enter the full HTTPS URL. For clients that require a collection URL, copy it from Radicale's collection manager.

Radicale serves `/.well-known/caldav` and `/.well-known/carddav` on its own hostname. OpenShip's standard HTTPS routing passes these requests and DAV methods to the app. Entering the DAV hostname lets compatible clients discover the collections without a custom path.

For clients that discover a server from the **email domain alone**, publish these optional DNS records for each mailbox domain (replace the target with your DAV hostname):

```text
_caldavs._tcp.example.com.  SRV  0 1 443 dav.example.com.
_carddavs._tcp.example.com. SRV  0 1 443 dav.example.com.
_caldavs._tcp.example.com.  TXT  "path=/"
_carddavs._tcp.example.com. TXT  "path=/"
```

DNS discovery support varies by client. The explicit HTTPS server address works without these records. If a client instead checks the mailbox domain's website for well-known URLs, configure redirects for those two paths on that website to the DAV HTTPS address; installing this app does not change another site's routes.

## Passwords and stored data

Successful logins are not cached. Changing a mailbox password or disabling its IMAP access applies to the next DAV request. Update the password in your calendar and contacts clients when it changes in Mail.

Collections live in the app's persistent `radicale_data` volume under `/var/lib/radicale/collections`, and survive deployments and container replacement. Include that volume in your backup plan. Removing a mailbox does not erase its stored collections; deleting and recreating the same mailbox address gives it access to those collections again. Renaming an address does not move its collections. Export or remove the old collections before reassigning an address.

The included web page manages collections and imports/exports. Calendar and contacts views inside OpenShip Webmail are a separate feature; this app does not add JMAP or change email delivery.

See the [Radicale documentation](https://radicale.org/v3.html) for client setup and collection management.
