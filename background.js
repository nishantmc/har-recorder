var version = "1.0";
var tabs = {};

import { Stats } from './stats.js';
import { StatsBuilder } from './stats.js';
import { HARBuilder } from './har.js';


// Set Icon
chrome.tabs.onActivated.addListener(function(activeInfo) {
  chrome.storage.local.get(['tabs'], function(result) {
    const tabs = result.tabs;
    if(tabs?.[activeInfo.tabId]) {
      chrome.action.setIcon({ path: "player_record.png" });
      chrome.action.setTitle({tabId: activeInfo.tabId, title: 'Click to stop record network requests.'});
    } else {
      chrome.action.setIcon({ path: "icons8-record-16.png" });
      chrome.action.setTitle({tabId: activeInfo.tabId, title: 'Click to start record network requests.'});
    }
  });
});


//TODO Remove async -   chrome.storage.local.get(['tabs'], async function(result) {
//Handle action clicked
chrome.action.onClicked.addListener(function(tab) {
  chrome.storage.local.get(['tabs'], async function(result) {
    let newTabs = result.tabs;

    if(newTabs?.[tab.id]) {
      chrome.debugger.detach({tabId:tab.id});
      chrome.action.setIcon({ path: "icons8-record-16.png" });
      chrome.action.setTitle({tabId: tab.id, title: 'Click to start record network requests.'});
      const fileName = new URL(tab.url).host;
      chrome.scripting.executeScript(
      {
        target: {tabId: tab.id},
        args: [encodeURIComponent(JSON.stringify(new HARBuilder().create([tabs[tab.id]]))), `${fileName}.har`],
        function: generateHARFile,
      });
      newTabs[tab.id] = undefined;
      await writeTabObject(newTabs);
      console.log(`Action clicked: Tab ${tab.id} now unregistered.`);
    } else {

      //initialize the prop
      if(!newTabs) {
        newTabs = {};
      }

      let stats = new Stats();
      tabs[tab.id] = stats;
      newTabs[tab.id] = stats;
      await writeTabObject(newTabs);

      chrome.action.setIcon({ path: "player_record.png" });
      chrome.action.setTitle({tabId: tab.id, title: 'Click to stop record network requests.'});
      chrome.debugger.attach({tabId:tab.id}, version, onAttach.bind(null, tab.id));
      chrome.debugger.sendCommand({tabId:tab.id}, "Network.enable");

      chrome.debugger.onEvent.addListener(async (debuggeeId, method, params) => {

        StatsBuilder.processEvent(stats, {method, params});
        tabs[tab.id] = stats;
        if(method === "Network.loadingFinished") {
          chrome.debugger.sendCommand({ tabId: tab.id }, "Network.getResponseBody", { requestId: params.requestId }, (responseBodyParams) => {
              if(responseBodyParams){
                const {body, base64Encoded} = responseBodyParams;
                StatsBuilder.processEvent(stats, {method: 'Network.getResponseBody', params: {
                  requestId: params.requestId,
                  body,
                  base64Encoded
                }});
               }
          });
        }
      });
    }
  });
});

function generateHARFile(encodedString, fileName) {
  var element = document.createElement('a');
  element.setAttribute('href', 'data:application/json,' + encodedString);
  element.setAttribute('download', fileName);
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
}



function onAttach(tabId) {
  if (chrome.runtime.lastError) {
    alert(chrome.runtime.lastError.message);
    return;
  }
}

function readTabObject() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['tabs'], function(result) {
        if (result['tabs']) {
            resolve(result['tabs']);
        } else {
            reject();
        }
    });
 });
}

function writeTabObject(tabs) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ tabs }, function(result) {
      resolve(tabs);
    });
 });
}

function readResponseBody(tabId, requestId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId }, (responseBody) => {
        resolve(responseBody);
    });
 });
}
