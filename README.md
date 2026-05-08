# SecureExam Online Examination System

SecureExam is a Node.js, Express, MySQL, Socket.IO, HTML, CSS, and JavaScript web app for secure online exams with Admin, Teacher, and Student dashboards.

## Features

- JWT login and registration with bcrypt password hashing
- Role-based dashboards for Admin, Teacher, and Student users
- Teacher exam builder with MCQ, dropdown, checkbox, short answer, paragraph, file upload, and image upload questions
- Access by exam code or direct link token
- Publish and unpublish workflow
- Student check-in, timed exam taking, auto-submit on timeout, and result viewing
- Auto scoring for objective questions
- Manual grading, answer feedback, and total score updates
- Camera and microphone permission tracking
- Tab-switch, screenshot key, copy/paste, small viewport phone-detection warnings
- Real-time Socket.IO monitor updates and text/voice chat
- Admin user management, activity logs, metrics, and simple charts
- Profile page and account themes: Default, Light Green, Light Blue, Baby Pink, and Dark Mode
- Render-ready environment variable setup

## Setup

1. Install dependencies:

```bash
npm install
```

2. Put your Aiven SSL CA certificate in:

```text
certs/ca.pem
```

If your certificate is somewhere else, update `DB_SSL_CA_PATH` in `.env`.

3. Initialize the database tables:

```bash
npm run init-db
```

The initializer creates the tables and seeds the first admin if no admin exists:

```text
Email: admin@secureexam.local
Password: admin12345
```

4. Start the app:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Important Security Notes

- Change `JWT_SECRET` before deployment.
- Change the seeded admin password after first login.
- Keep `.env` and `certs/ca.pem` private. They are ignored by git.
- Browser-based screenshot and phone detection are best-effort. Web apps cannot fully prevent screenshots on all devices, but this system detects common attempts and records warning events.

## Render Deployment

Set these Render environment variables:

```text
PORT
JWT_SECRET
DB_HOST
DB_PORT
DB_USER
DB_PASS
DB_NAME
DB_SSL_CA_PATH
UPLOAD_DIR
```

For the Aiven certificate on Render, upload the CA certificate as a secret file or place it during build/deploy and point `DB_SSL_CA_PATH` to that file path.

Use these commands:

```text
Build Command: npm install
Start Command: npm start
```

Run `npm run init-db` once from a Render shell or locally against the Aiven database.
