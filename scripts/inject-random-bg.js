hexo.extend.filter.register('after_render:html', function (str, data) {
    var bgList = hexo.theme.config.background.list;
    if (!bgList || !bgList.length) return str;

    var script = '<script>' +
        '(function(){' +
        'var backgrounds=' + JSON.stringify(bgList) + ';' +
        'var bg=backgrounds[Math.floor(Math.random()*backgrounds.length)];' +
        'document.querySelector(".kira-background").style.backgroundImage="url("+bg+")";' +
        '})();' +
        '</script>';

    return str.replace('</body>', script + '</body>');
});
