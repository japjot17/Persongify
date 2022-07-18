const express = require("express");
const path = require("path");
const axios = require("axios");
const qs = require("qs");
const shajs = require("sha.js");
const cookieParser = require("cookie-parser");
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}
// connect to postgreSQL
const { Pool } = require("pg");
const pool = new Pool({
  // localhost server
  // connectionString: "postgres://postgres:root@localhost",

  // heroku server
  connectionString: process.env.DATABASE_URL,
  ssl: {
    require: true,
    rejectUnauthorized: false,
  },
});

/************************* HELPER FUNCTIONS **********************************/
const app = express();

/**
 * generates a random string
 * @param {number} length
 * @returns {string} the generated string
 */
var generateRandomString = function (length) {
  var text = "";
  var possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  for (var i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

var encryptSHA256 = function (plain) {
  return new shajs.sha256().update(plain).digest("hex");
};

var checkAuthorizedUser = function (req) {
  console.log("req.signedCookies['persongify_auth']: ", req.signedCookies['persongify_auth']);
  if (req.signedCookies['persongify_auth']) return true;
  return false;
};

// helper function to check if the query doesn't have any results
function notEmptyQueryCheck(rows) {
  if (rows != undefined && rows.rowCount != 0) {
    return true;
  } else {
    return false;
  }
}

// understand JSON
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// work with cookies
var cookieSecret = generateRandomString(20);
app.use(cookieParser(cookieSecret));

// redirection after login
var redir;

/*****************************************************************************/

// basic routing
app.use(express.static(path.join(__dirname, "public")));
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.get("/", (req, res) => {
  //   res
  //     .status(200)
  //     .send('Hello server is running')
  //     .end();
  // res.render("pages/start-page");
  app.locals.signedIn = false;
  app.locals.redir = '/home';
  res.clearCookie("persongify_auth", { signed: true });
  res.clearCookie("spotify_auth", { signed: true });

  res.redirect("/home");
});

app.get("/home", (req, res) => {
  // res.sendFile(path.join(__dirname, "/public/home.html"));
  // if (checkAuthorizedUser(req)) {
  //   app.locals.signedIn = true;
  // }
  // else {
  //   app.locals.signedIn = false;
  // }
  res.render('pages/home');
});

/********************** POSTGRES ACCOUNT SETUP *******************************/

app.get("/newUser", (req, res) => {
  res.render("pages/user-add");
});

app.post("/addUser", async (req, res) => {
  var userName = req.body.f_uname;
  var firstName = req.body.f_firstName;
  var lastName = req.body.f_lastName;
  var age = req.body.f_age;

  var pwd = req.body.f_pwd;
  var pwdSHA256 = encryptSHA256(pwd);

  var query = `INSERT INTO useracct (id, username, firstname, lastname, age, password) VALUES (DEFAULT, $1, $2, $3, $4, $5)`;
  var values = [userName, firstName, lastName, age, pwdSHA256];

  var rows = await pool.query(query, values);
  if (notEmptyQueryCheck(rows)) {
	  // res.status(201);
    res.cookie("persongify_auth", userName, { signed: true });
    // res.send("successfully added user: " + userName);
    app.locals.signedIn = true;
    let url = app.locals.redir;
    app.locals.redir = '/home';
    res.redirect(201, url);
  } else {
    res.redirect(500, "/newUser");
  }
});

app.get("/login", (req, res) => {
  res.render("pages/user-login");
});

app.post("/verify-login", async (req, res) => {
  var chk_uname = req.body.f_uname;
  var chk_pwd = req.body.f_pwd;
  var chk_pwdSHA256 = encryptSHA256(chk_pwd);

  var query = `SELECT * FROM useracct WHERE username=$1 AND password=$2`;
  var values = [chk_uname, chk_pwdSHA256];

  var rows = await pool.query(query, values);
  if (notEmptyQueryCheck(rows)) {
    res.cookie("persongify_auth", chk_uname, { signed: true });
    console.log("successfully logged on user: " + chk_uname);
    app.locals.signedIn = true;
    let url = app.locals.redir;
    app.locals.redir = '/home';
    res.redirect(200, url);
  } else {
    res.redirect(401, "/login");
  }
});

app.get("/logout", (req, res) => {
  app.locals.signedIn = false;
  app.locals.redir = '/home';
  res.clearCookie("persongify_auth", { signed: true });
  res.clearCookie("spotify_auth", { signed: true });

  res.redirect('/home');
})

/************************* SPOTIFY OAUTH ROUTING *****************************/
var client_id = process.env.CLIENT_ID || "0f6749aefe004361b5c218e24c953814";
var client_secret =
  process.env.CLIENT_SECRET || "4940d82140ff4e47add12d60060cbcbc";
var redirect_uri =
  process.env.REDIRECT_URI || "http://localhost:5000/spotify-callback";


app.get("/spotify-login", (req, res) => {
  if (!checkAuthorizedUser(req)) {
    app.locals.redir = req.originalUrl;
    res.redirect(401, "/login");
  }
  else {
    var state = generateRandomString(16);
    var scope =
      "user-read-private user-read-email user-library-modify user-library-read playlist-modify-private playlist-modify-public playlist-read-private user-top-read user-read-recently-played user-follow-read user-follow-modify";

    res.redirect(
      "https://accounts.spotify.com/authorize?" +
        qs.stringify({
          response_type: "code",
          client_id: client_id,
          scope: scope,
          redirect_uri: redirect_uri,
          state: state,
        })
    );
  }
  
});

var newToken;

app.get("/spotify-callback", (req, res) => {
  // given from login redirect
  var code = req.query.code || null;
  var state = req.query.state || null;

  if (state === null) {
    res.send("STATE MISMATCH");
  } else {
    axios({
      method: "post",
      url: "https://accounts.spotify.com/api/token",
      data: qs.stringify({
        code: code,
        redirect_uri: redirect_uri,
        grant_type: "authorization_code",
      }),
      headers: {
        Authorization:
          "Basic " +
          new Buffer.from(client_id + ":" + client_secret).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      json: true,
    })
      .then((response) => {
        if (response.status === 200) {
          res.cookie("spotify_auth", state, { signed: true });
          newToken = response.data;
          res.redirect("/trending");
        } else {
          res.send(response);
        }
      })
      .catch((error) => {
        console.log(error.response);
        res.send(error);
      });
  }
});

app.get("/token-api", (req, res) => {
  
  res.json(newToken);

});

app.get("/trending", (req, res) => {
  if (checkAuthorizedUser(req)) {
    res.sendFile(path.join(__dirname, "/public/trending.html"));
  } else {
    redir = req.originalUrl;
    res.redirect(401, "/login");
  }
});

//generating recommendations
var songs = [];
var artists = [];
var SpotifyWebApi = require('spotify-web-api-node');

var spotifyApi = new SpotifyWebApi({
  clientId: client_id,
  clientSecret: client_secret
});

// Retrieve an access token.
spotifyApi.clientCredentialsGrant().then(
  function(data) {
    console.log('The access token expires in ' + data.body['expires_in']);
    

    // Save the access token so that it's used in future calls
    spotifyApi.setAccessToken(data.body['access_token']);
  },
  function(err) {
    console.log('Something went wrong when retrieving an access token', err);
  }
);

app.post("/songs", function(req,res){

    var limit = req.body.limit;
    var genre = req.body.genre;
    var dance = req.body.danceability;
    var energy = req.body.energy;


    spotifyApi.getRecommendations({
        limit: limit,
        seed_genres: genre,
        target_danceability: dance,
        target_energy: energy
      })
    .then(function(data) {
        console.log("working");

        
      let recommendations = data.body.tracks;
      for(let i = 0; i<recommendations.length; i++){

        songs.push(recommendations[i].name);
        artists.push(recommendations[i].artists[0].name);

        
      }
      res.redirect("/songs");
    
    }, function(err) {
      console.log("Something went wrong!", err);
    });


})

app.get("/songs", function(req,res){

  for(let i = 0; i<songs.length;i++){
      console.log(artists[i]);
  }

  if (checkAuthorizedUser(req)) {
    res.render("pages/songs", {songs:songs, artists:artists});
  } else {
    redir = req.originalUrl;
    res.redirect(401, "/login");
  }

})

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
  console.log("Press Ctrl+C to quit.");
});

// for testing
module.exports = app;
