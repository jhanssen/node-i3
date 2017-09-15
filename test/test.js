/*global require*/

const I3 = require("../");

const i3 = new I3();
i3.open().then(() => {
    console.log("opened");

    i3.on("error", err => {
        console.log("got error", err);
    });

    i3.on("workspace", ws => {
        console.log("got workspaces", ws);
    });

    i3.send("GET_WORKSPACES").then(data => {
        console.log("workspaces", data);
    }).catch(err => {
        console.error("error", err);
    });

    i3.send(new I3.Message("COMMAND", "focus right")).then(data => {
        console.log("focus", data);
    }).catch(err => {
        console.error("error", err);
    });
}).catch(err => {
    console.error("error", err);
});
