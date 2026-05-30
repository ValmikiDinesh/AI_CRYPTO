# ☁️ AWS Deployment & Live Sync Troubleshooting Guide

This guide explains why live data syncing works perfectly on your local machine but fails in AWS, and provides step-by-step solutions to fix it.

---

## 🔍 The Root Cause
On your local machine, Vite's development server (`vite.config.js`) acts as a **reverse proxy**. When the client website makes relative requests to `/api` or `/socket.io`, Vite automatically forwards them to the backend running on `http://localhost:5050`.

**In AWS production hosting:**
1. Vite's development server does not run; instead, you build the static assets (`npm run build` inside `/client` which outputs to `/client/dist`).
2. If your built static files are served on **Domain A** (e.g., an S3 Bucket, CloudFront, or Amplify) and your Node.js backend runs on **Domain B** (e.g., an EC2 instance), relative requests to `/api` and `/socket.io` are sent to the static hosting server (Domain A) which does not run Node, resulting in **404 Not Found** or **Connection Refused** errors.

---

## 🛠️ Solution 1: Nginx Reverse Proxy (Single EC2 Instance - RECOMMENDED)
If you are hosting both the backend and frontend on a single EC2 instance, the most elegant and standard setup is to use **Nginx** as a reverse proxy. This mirrors your local development setup perfectly, meaning **zero code changes are required**!

### 1. Build the Frontend
On the EC2 instance, build your Vite frontend:
```bash
cd client
npm install
npm run build
```

### 2. Configure Nginx
Create or edit your Nginx server block (usually at `/etc/nginx/sites-available/default`):

```nginx
server {
    listen 80;
    server_name your-domain-or-public-ip.com;

    # 1. Serve Built Frontend Static Files
    location / {
        root /home/ubuntu/AI_CRYPTO/client/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # 2. Proxy REST API Requests to Node Backend
    location /api/ {
        proxy_pass http://127.0.0.1:5050;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # 3. Proxy Socket.io WebSockets to Node Backend
    location /socket.io/ {
        proxy_pass http://127.0.0.1:5050;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 3. Restart Nginx & Start Backend
```bash
sudo nginx -t
sudo systemctl restart nginx

# Run your backend in background using PM2 so it doesn't close
cd ../server
npm install -g pm2
pm2 start server.js --name "crypto-backend"
```

---

## 🛠️ Solution 2: AWS S3 + CloudFront Split Hosting
If you host your built frontend in an **S3 bucket** (with static website hosting) and your backend on an **EC2 instance**:

### 1. Configure CloudFront Behaviors
To avoid CORS issues and let relative paths work, configure your **CloudFront Distribution** with multiple origins and behaviors:

* **Origin 1 (S3 Bucket)**: `your-bucket.s3-website-us-east-1.amazonaws.com`
* **Origin 2 (EC2 Instance)**: `http://your-ec2-public-dns.amazonaws.com:5050`

Create the following **Behaviors** in CloudFront:

| Path Pattern | Origin | Cache Policy | Origin Request Policy |
| :--- | :--- | :--- | :--- |
| `/api/*` | Origin 2 (EC2) | CachingDisabled | AllViewerExceptHostHeader |
| `/socket.io/*` | Origin 2 (EC2) | CachingDisabled | AllViewerExceptHostHeader |
| `Default (*)` | Origin 1 (S3) | CachingOptimized | (Default) |

*Note: For `/socket.io/*`, make sure to enable **WebSockets** support under the CloudFront Behavior settings by allowing all HTTP methods and header forwarding.*

---

## 🛠️ Solution 3: Hardcoding AWS Backend URL (Client Build Time)
If you cannot set up a reverse proxy, you can compile the client with an absolute backend URL.

### 1. Update the Store Socket URL
In `client/src/store.js`, we fall back to `import.meta.env.VITE_API_URL`. 
During your AWS frontend build process (e.g. in AWS Amplify, Netlify, or Github Actions), you **MUST** declare the environment variable:
```env
VITE_API_URL=http://your-ec2-ip-or-domain:5050
```
This forces the compiled javascript to connect directly to the EC2 IP.

### 2. Configure CORS on Backend (`server/.env`)
Since your S3 bucket and EC2 instance will be on different domains, you **MUST** allow the S3 domain in the backend `.env`:
```env
CLIENT_URL=http://your-s3-bucket-url.amazonaws.com
```
