hexo.extend.filter.register('after_render:html', function (str, data) {
    var l2dConfig = hexo.theme.config.l2d;
    if (!l2dConfig || !l2dConfig.enable) return str;

    var modelPath = l2dConfig.modelPath || 'https://model.hacxy.cn/Haru/Haru.model3.json';
    var width = l2dConfig.width || 300;
    var height = l2dConfig.height || 400;

    var canvas = '<canvas id="l2d-canvas" style="position:fixed;right:0;bottom:0;width:' +
        width + 'px;height:' + height + 'px;z-index:9999;pointer-events:none;"></canvas>';

    var script = '<script src="https://unpkg.com/l2d/dist/index.min.js"></script>' +
        '<script>' +
        '(function(){var c=document.getElementById("l2d-canvas");' +
        'if(!c)return;' +
        'var l2d=L2D.init(c);' +
        'l2d.on("loaded",function(){console.log("L2D加载完成");});' +
        'l2d.load({path:' + JSON.stringify(modelPath) + '});' +
        '})();' +
        '</script>';

    return str.replace('</body>', canvas + script + '</body>');
});
