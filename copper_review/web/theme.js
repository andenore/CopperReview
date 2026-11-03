/* Light is the default theme; a reviewer's choice of dark is remembered in this browser. A classic
   script in <head>, so the page never paints in the wrong theme first. */
try{if(localStorage.getItem('copper-review:theme')==='dark')document.documentElement.dataset.theme='dark';}catch{}
