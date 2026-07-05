(function(){
  var tas=Array.from(document.querySelectorAll("textarea"));
  var ta=tas.find(function(t){return /输入写作需求/.test(t.placeholder||"");});
  if(!ta){ta=tas[tas.length-1];}
  if(!ta){return "textarea-not-found; count="+tas.length;}
  var prompt="Generate chapter 18 body. UAT_SCRIPT1_SURGICAL_S55. Only output the chapter body.";
  var nativeSetter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;
  nativeSetter.call(ta,prompt);
  ta.dispatchEvent(new InputEvent("input",{bubbles:true,cancelable:true,inputType:"insertingText",data:prompt}));
  ta.dispatchEvent(new Event("input",{bubbles:true}));
  ta.dispatchEvent(new Event("change",{bubbles:true}));
  return "value-set; len="+ta.value.length;
})()
