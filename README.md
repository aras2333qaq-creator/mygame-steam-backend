# MyGame Steam Backend

## Railway environment variables

Set `STEAM_API_KEY` in Railway. `PORT` is provided automatically by Railway.

`BASE_URL` is optional: if omitted, the backend automatically uses the public Railway request URL, which avoids a deployment crash caused by an outdated or missing domain.

After deployment, open `/health`. It should return `ok: true` before testing Steam login.
