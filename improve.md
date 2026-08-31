# Scaling and Production Readiness Guide: Host-Based Malpractice Detection System (HBMDS)[cite: 2]

Transitioning this architecture from a local development environment to an institutional lab capable of handling hundreds or thousands of concurrent students requires optimizing bottlenecks and locking down the deployment environment[cite: 2].

By keeping the monitoring strictly focused on browser tab, window focus, and OS interactions, avoiding the overhead of biometrics or external device tracking, the extension remains highly performant[cite: 2]. Below is the blueprint for scaling this system[cite: 2].

---

## 1. Architecture and Performance Scaling[cite: 2]

When 1,000 students take an exam, the server will process around 220 heartbeat and ping requests every second[cite: 2]. Direct database writes for every ping will overwhelm a default MongoDB instance[cite: 2].

### A. In-Memory State Management (Redis)[cite: 2]
Instead of keeping the session tracking Map in Node.js memory, migrate this to a Redis cache[cite: 2].
*   **Why:** This decouples the watchdog logic from the Node process, allowing you to run multiple instances of the Node server behind a load balancer without losing track of a student's heartbeat[cite: 2].
*   **Implementation:** Use Redis keys with a Time-To-Live (TTL) of 15 seconds[cite: 2]. If a heartbeat updates the key, the TTL resets[cite: 2]. If the key expires, Redis can emit an expiration event that the server captures to instantly flag a `CRITICAL_DISCONNECT`[cite: 2].

### B. Event Batching (Client-Side)[cite: 2]
High-frequency events, like a student rapidly resizing the window or mashing restricted keys, will spam the `/api/report` endpoint[cite: 2].
*   Modify `content.js` to push non-critical events into a buffer array[cite: 2].
*   Flush the buffer to the server every 3 to 5 seconds using `navigator.sendBeacon()`[cite: 2].
*   Critical events, like `DEVTOOLS_OPEN` or `TAB_SWITCH`, should still trigger an immediate POST request[cite: 2].

### C. Database Connection Pooling[cite: 2]
Ensure Mongoose is configured to handle the concurrent load during exam startup and submission rushes[cite: 2].
`mongoose.connect(process.env.MONGO_URI, { maxPoolSize: 100, wtimeoutMS: 2500 });`[cite: 2]

---

## 2. Infrastructure and Deployment[cite: 2]

To ensure stability across the campus network, the deployment should be containerized and sit behind a robust proxy layer[cite: 2].

### A. Dockerization[cite: 2]
Package the Node.js API, MongoDB, and Redis into separate Docker containers managed via `docker-compose`[cite: 2]. This ensures consistent runtime environments across different lab servers and simplifies restarts if a process crashes[cite: 2].

### B. Nginx Reverse Proxy[cite: 2]
Never expose the Node.js server directly to the network[cite: 2]. Place Nginx in front of it[cite: 2].
*   **Static File Serving:** Let Nginx serve the static assets like `login.html` and the admin dashboard[cite: 2]. Nginx handles static files exponentially faster than Express, freeing up the Node event loop entirely for API and WebSocket traffic[cite: 2].
*   **Load Balancing:** If you scale to multiple Node containers, Nginx will distribute the WebSocket and HTTP traffic evenly[cite: 2].
*   **TLS Termination:** Handle SSL certificates at the Nginx layer to encrypt traffic over the campus network without burdening the Node application[cite: 2].

---

## 3. Institutional Rollout and Extension Management[cite: 2]

Relying on Developer Mode is a major security flaw for production, as students can easily inspect, pause, or disable the background scripts[cite: 2].

### A. Active Directory Group Policy (GPO)[cite: 2]
For campus labs running Windows environments, deploy the extension via Active Directory Group Policy[cite: 2].
*   Use the `ExtensionInstallForcelist` policy to silently push the extension to all lab machines[cite: 2].
*   This prevents students from uninstalling the extension or accessing `chrome://extensions` to toggle it off[cite: 2].
*   Enforce the `DeveloperToolsAvailability` policy to disable DevTools entirely on the browser, adding an OS-level safeguard alongside your `content.js` listener[cite: 2].

### B. Dynamic Server Configuration[cite: 2]
Remove `localhost:3000` from your `manifest.json`[cite: 2]. Use Chrome Enterprise Policy (`chrome.storage.managed`) to push the production `SERVER_URL` directly to the extension[cite: 2].
*   The extension reads the authorized API endpoint from managed storage on load[cite: 2].
*   This allows the same extension build to be used across different subnets or backup servers simply by updating the AD policy, requiring no code changes[cite: 2].

---

## 4. Advanced Security and Monitoring[cite: 2]

### B. Offline Resilience Tuning[cite: 2]
Your current IndexedDB offline queue is excellent[cite: 2]. To optimize it for production:[cite: 2]
*   Add a timestamp signature to queued events[cite: 2].
*   When the network reconnects and the queue flushes, the server must calculate latency based on the client's original timestamp versus the server's current time, adjusting the `latencyMs` metric so offline bursts do not trigger false latency alerts on the admin dashboard[cite: 2].